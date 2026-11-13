#!/usr/bin/env node

import path from 'node:path';
import { Command } from 'commander';
import cliProgress from 'cli-progress';
import chalk from 'chalk';
import {
  DEFAULTS,
  formatBytes,
  formatDuration,
  logError,
  normalizeOptions,
  runConversion,
} from './core.js';

/** Путь к лог-файлу с ошибками. */
const errorLogPath = path.resolve(process.cwd(), 'errors.log');

/** Флаг прерывания через SIGINT. */
let interrupted = false;

/** Последний снимок статистики (для вывода при SIGINT). */
let lastStats = null;

/**
 * Парсит аргументы CLI.
 * @returns {object}
 */
function parseArgs() {
  const program = new Command();
  const int = (v) => parseInt(v, 10);

  program
    .name('png-to-webp')
    .description(
      'Рекурсивная конвертация изображений в WebP с использованием sharp',
    )
    .requiredOption('-i, --input <path>', 'путь к папке с изображениями')
    .option(
      '-o, --output <path>',
      'путь к выходной папке (по умолчанию рядом с оригиналом)',
    )
    .option('-q, --quality <number>', 'качество сжатия 1-100', int, DEFAULTS.quality)
    .option('--lossless', 'режим сжатия без потерь', false)
    .option('-e, --effort <number>', 'уровень компрессии 0-6', int, DEFAULTS.effort)
    .option('--keep-original [bool]', 'сохранять оригиналы (true/false)', 'true')
    .option(
      '--skip-existing [bool]',
      'пропускать уже сконвертированные (true/false)',
      'true',
    )
    .option('--formats <list>', 'список расширений через запятую', DEFAULTS.formats)
    .option(
      '--max-width <number>',
      'максимальная ширина в пикселях (с сохранением пропорций)',
      int,
    )
    .option(
      '-c, --concurrency <number>',
      'количество параллельных операций (по умолчанию число ядер CPU)',
      int,
      DEFAULTS.concurrency,
    );

  program.parse(process.argv);
  const o = program.opts();

  /** Преобразует строку 'true'/'false' (или boolean) в boolean. */
  const toBool = (v, fallback) => {
    if (typeof v === 'boolean') return v;
    if (v === undefined || v === null) return fallback;
    const s = String(v).toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(s)) return true;
    if (['false', '0', 'no', 'n'].includes(s)) return false;
    return fallback;
  };

  return normalizeOptions({
    ...o,
    lossless: Boolean(o.lossless),
    keepOriginal: toBool(o.keepOriginal, true),
    skipExisting: toBool(o.skipExisting, true),
    maxWidth: o.maxWidth === undefined ? null : o.maxWidth,
  });
}

/**
 * Печатает итоговую статистику обработки.
 * @param {object} stats
 */
function printSummary(stats) {
  const saved = stats.bytesBefore - stats.bytesAfter;
  const savedPct =
    stats.bytesBefore > 0 ? (saved / stats.bytesBefore) * 100 : 0;

  console.log('');
  console.log(
    chalk.bold.cyan('━━━━━━━━━━━━━━━━━━━━ Итоги ━━━━━━━━━━━━━━━━━━━━'),
  );
  console.log(`${chalk.bold('Всего файлов:')}      ${stats.total}`);
  console.log(`${chalk.green('✓ Сконвертировано:')} ${stats.converted}`);
  console.log(`${chalk.blue('● Скопировано:')}     ${stats.copied}`);
  console.log(`${chalk.yellow('⊘ Пропущено:')}       ${stats.skipped}`);
  console.log(`${chalk.red('✗ Ошибок:')}          ${stats.errors}`);
  console.log('');
  console.log(
    `${chalk.bold('Размер до:')}    ${formatBytes(stats.bytesBefore)}`,
  );
  console.log(
    `${chalk.bold('Размер после:')} ${formatBytes(stats.bytesAfter)}`,
  );
  if (stats.bytesBefore > 0) {
    const color = savedPct >= 0 ? chalk.green : chalk.red;
    console.log(
      `${chalk.bold('Экономия:')}     ${color(`${formatBytes(saved)} (${savedPct.toFixed(2)}%)`)}`,
    );
  }
  console.log(
    `${chalk.bold('Время:')}        ${formatDuration(stats.elapsedMs)}`,
  );
  if (stats.errors > 0) {
    console.log('');
    console.log(chalk.red(`Подробности ошибок записаны в ${errorLogPath}`));
  }
  console.log(
    chalk.bold.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'),
  );
}

/**
 * Главная точка входа.
 */
async function main() {
  let args;
  try {
    args = parseArgs();
  } catch (err) {
    console.error(chalk.red(`✗ Ошибка аргументов: ${err.message}`));
    process.exit(1);
  }

  console.log(chalk.bold.cyan('🚀 Конвертация изображений в WebP'));
  console.log(`${chalk.bold('Вход:')}        ${args.input}`);
  console.log(
    `${chalk.bold('Выход:')}       ${args.output ?? chalk.dim('(рядом с оригиналами)')}`,
  );
  console.log(
    `${chalk.bold('Параметры:')}   quality=${args.quality}, lossless=${args.lossless}, effort=${args.effort}` +
      `${args.maxWidth ? `, maxWidth=${args.maxWidth}` : ''}`,
  );
  console.log(`${chalk.bold('Форматы:')}     ${[...args.formats].join(', ')}`);
  console.log(
    `${chalk.bold('Поведение:')}   keepOriginal=${args.keepOriginal}, skipExisting=${args.skipExisting}, concurrency=${args.concurrency}`,
  );
  console.log('');
  console.log(chalk.dim('Сканирую файлы...'));

  const bar = new cliProgress.SingleBar(
    {
      format:
        chalk.cyan('{bar}') +
        ' {percentage}% | {value}/{total} | ' +
        chalk.bold('{rate}/s') +
        ' | ETA: {etaFormatted} | ' +
        chalk.dim('{filename}'),
      barCompleteChar: '█',
      barIncompleteChar: '░',
      hideCursor: true,
      clearOnComplete: false,
      stopOnComplete: false,
      etaBuffer: 50,
      fps: 10,
    },
    cliProgress.Presets.shades_classic,
  );

  let stats;
  try {
    stats = await runConversion(args, {
      errorLogPath,
      isCancelled: () => interrupted,
      onScan: ({ files, nonConvertible, totalWork }) => {
        console.log(
          chalk.green(`✓ Найдено изображений для конвертации: ${files}`),
        );
        if (nonConvertible > 0) {
          console.log(
            chalk.dim(`● Файлов не подлежащих конвертации: ${nonConvertible}`),
          );
        }
        console.log('');
        bar.start(totalWork, 0, {
          filename: '',
          rate: '0.00',
          etaFormatted: '--:--',
        });
      },
      onProgress: ({ file, stats: s, totalWork }) => {
        lastStats = s;
        const elapsedSec = s.elapsedMs / 1000;
        const processed = s.converted + s.skipped + s.errors + s.copied;
        const rate =
          elapsedSec > 0 ? (processed / elapsedSec).toFixed(2) : '0.00';
        const etaSec =
          elapsedSec > 0 && processed > 0
            ? ((totalWork - processed) * elapsedSec) / processed
            : 0;
        bar.increment(1, {
          filename: file.length > 50 ? `…${file.slice(-49)}` : file,
          rate,
          etaFormatted: etaSec > 0 ? formatDuration(etaSec * 1000) : '--:--',
        });
      },
    });
  } catch (err) {
    bar.stop();
    console.error(chalk.red(`✗ ${err.message}`));
    process.exit(1);
  }

  bar.stop();
  printSummary(stats);
}

// SIGINT: корректный выход с печатью статистики уже обработанного.
process.on('SIGINT', () => {
  if (interrupted) {
    process.exit(130);
  }
  interrupted = true;
  console.log('');
  console.log(chalk.yellow('⚠ Получен SIGINT. Завершаю текущие задачи...'));
  // Даём p-limit завершить уже запущенные задачи; новые пропускаются.
  setTimeout(() => {
    if (lastStats) printSummary(lastStats);
    process.exit(130);
  }, 500);
});

main().catch(async (err) => {
  console.error(
    chalk.red(`✗ Критическая ошибка: ${err.stack ?? err.message ?? err}`),
  );
  await logError(
    errorLogPath,
    `Критическая ошибка: ${err.stack ?? err.message ?? err}`,
  );
  process.exit(1);
});
