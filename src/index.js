#!/usr/bin/env node

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Command } from 'commander';
import sharp from 'sharp';
import pLimit from 'p-limit';
import cliProgress from 'cli-progress';
import chalk from 'chalk';

/**
 * Глобальная статистика обработки.
 */
const stats = {
  total: 0,
  converted: 0,
  copied: 0,
  skipped: 0,
  errors: 0,
  bytesBefore: 0,
  bytesAfter: 0,
  startTime: 0,
};

/** Путь к лог-файлу с ошибками (инициализируется при старте). */
let errorLogPath = path.resolve(process.cwd(), 'errors.log');

/** Флаг прерывания через SIGINT. */
let interrupted = false;

/**
 * Преобразует число байт в человекочитаемую строку (B, KB, MB, GB).
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(2)} ${units[i]}`;
}

/**
 * Форматирует длительность из миллисекунд в HH:MM:SS / MM:SS / SS.s.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  if (minutes > 0) {
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Дописывает строку в errors.log.
 * @param {string} message
 */
async function logError(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    await fs.appendFile(errorLogPath, line, 'utf8');
  } catch {
    // Если лог не пишется — игнорируем, чтобы не уронить процесс.
  }
}

/**
 * Рекурсивно собирает список файлов-изображений в указанной директории.
 * @param {string} dir - корневая директория для обхода
 * @param {Set<string>} extensions - набор расширений в нижнем регистре с точкой (например, '.jpg')
 * @returns {Promise<string[]>} абсолютные пути к найденным файлам
 */
async function collectImages(dir, extensions) {
  const result = [];

  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      await logError(
        `Не удалось прочитать директорию ${current}: ${err.message}`,
      );
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (extensions.has(ext)) {
          result.push(full);
        }
      }
    }
  }

  await walk(dir);
  return result;
}

/**
 * Собирает все файлы (без фильтра по расширениям) рекурсивно.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function collectAllFiles(dir) {
  const result = [];

  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      await logError(
        `Не удалось прочитать директорию ${current}: ${err.message}`,
      );
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        result.push(full);
      }
    }
  }

  await walk(dir);
  return result;
}

/**
 * Гарантирует существование директории (создаёт рекурсивно при необходимости).
 * @param {string} dir
 */
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Возвращает путь, по которому должен быть сохранён результирующий .webp файл.
 * @param {string} sourceFile - абсолютный путь исходного файла
 * @param {string} inputRoot - корневая входная директория
 * @param {string|null} outputRoot - корневая выходная директория или null
 * @returns {string}
 */
function resolveOutputPath(sourceFile, inputRoot, outputRoot) {
  const parsed = path.parse(sourceFile);
  if (!outputRoot) {
    return path.join(parsed.dir, `${parsed.name}.webp`);
  }
  const relativeDir = path.relative(inputRoot, parsed.dir);
  const targetDir = path.join(outputRoot, relativeDir);
  return path.join(targetDir, `${parsed.name}.webp`);
}

/**
 * Путь для копирования не-конвертируемого файла в выходную директорию.
 * Если outputRoot === null, возвращает null.
 */
function resolveCopyPath(sourceFile, inputRoot, outputRoot) {
  if (!outputRoot) return null;
  const parsed = path.parse(sourceFile);
  const relativeDir = path.relative(inputRoot, parsed.dir);
  const targetDir = path.join(outputRoot, relativeDir);
  return path.join(targetDir, parsed.base);
}

/**
 * Конвертирует одно изображение в WebP.
 * @param {string} sourceFile
 * @param {string} targetFile
 * @param {object} opts
 * @param {number} opts.quality
 * @param {boolean} opts.lossless
 * @param {number} opts.effort
 * @param {number|null} opts.maxWidth
 * @param {boolean} opts.skipExisting
 * @param {boolean} opts.keepOriginal
 * @returns {Promise<{status: 'converted'|'skipped'|'error', sizeBefore: number, sizeAfter: number, error?: Error}>}
 */
async function convertFile(sourceFile, targetFile, opts) {
  const sourceStat = await fs.stat(sourceFile);
  const sizeBefore = sourceStat.size;

  if (opts.skipExisting) {
    try {
      await fs.access(targetFile);
      return { status: 'skipped', sizeBefore, sizeAfter: 0 };
    } catch {
      // Файл не существует — продолжаем конвертацию.
    }
  }

  await ensureDir(path.dirname(targetFile));

  try {
    let pipeline = sharp(sourceFile, { failOn: 'none' });

    if (opts.maxWidth) {
      pipeline = pipeline.resize({
        width: opts.maxWidth,
        withoutEnlargement: true,
        fit: 'inside',
      });
    }

    pipeline = pipeline.webp({
      quality: opts.quality,
      lossless: opts.lossless,
      effort: opts.effort,
    });

    await pipeline.toFile(targetFile);
    const targetStat = await fs.stat(targetFile);
    const sizeAfter = targetStat.size;

    if (!opts.keepOriginal) {
      // Удаляем оригинал только если результирующий файл лежит по другому пути,
      // чтобы случайно не удалить только что записанный .webp.
      if (path.resolve(sourceFile) !== path.resolve(targetFile)) {
        try {
          await fs.unlink(sourceFile);
        } catch (err) {
          await logError(
            `Не удалось удалить оригинал ${sourceFile}: ${err.message}`,
          );
        }
      }
    }

    return { status: 'converted', sizeBefore, sizeAfter };
  } catch (err) {
    return { status: 'error', sizeBefore, sizeAfter: 0, error: err };
  }
}

/**
 * Парсит аргументы CLI.
 * @returns {object}
 */
function parseArgs() {
  const program = new Command();

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
    .option(
      '-q, --quality <number>',
      'качество сжатия 1-100',
      (v) => parseInt(v, 10),
      80,
    )
    .option('--lossless', 'режим сжатия без потерь', false)
    .option(
      '-e, --effort <number>',
      'уровень компрессии 0-6',
      (v) => parseInt(v, 10),
      4,
    )
    .option(
      '--keep-original [bool]',
      'сохранять оригиналы (true/false)',
      'true',
    )
    .option(
      '--skip-existing [bool]',
      'пропускать уже сконвертированные (true/false)',
      'true',
    )
    .option(
      '--formats <list>',
      'список расширений через запятую',
      'jpg,jpeg,png,gif,tiff,bmp,avif',
    )
    .option(
      '--max-width <number>',
      'максимальная ширина в пикселях (с сохранением пропорций)',
      (v) => parseInt(v, 10),
    )
    .option(
      '-c, --concurrency <number>',
      'количество параллельных операций (по умолчанию число ядер CPU)',
      (v) => parseInt(v, 10),
      os.cpus().length,
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

  if (!Number.isFinite(o.quality) || o.quality < 1 || o.quality > 100) {
    throw new Error('quality должен быть числом 1-100');
  }
  if (!Number.isFinite(o.effort) || o.effort < 0 || o.effort > 6) {
    throw new Error('effort должен быть числом 0-6');
  }
  if (
    o.maxWidth !== undefined &&
    (!Number.isFinite(o.maxWidth) || o.maxWidth < 1)
  ) {
    throw new Error('max-width должен быть положительным числом');
  }
  if (!Number.isFinite(o.concurrency) || o.concurrency < 1) {
    throw new Error('concurrency должен быть положительным числом');
  }

  const formats = String(o.formats)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => (s.startsWith('.') ? s : `.${s}`));

  return {
    input: path.resolve(o.input),
    output: o.output ? path.resolve(o.output) : null,
    quality: o.quality,
    lossless: Boolean(o.lossless),
    effort: o.effort,
    keepOriginal: toBool(o.keepOriginal, true),
    skipExisting: toBool(o.skipExisting, true),
    formats: new Set(formats),
    maxWidth: Number.isFinite(o.maxWidth) ? o.maxWidth : null,
    concurrency: o.concurrency,
  };
}

/**
 * Печатает итоговую статистику обработки.
 */
function printSummary() {
  const elapsed = performance.now() - stats.startTime;
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
  console.log(`${chalk.bold('Время:')}        ${formatDuration(elapsed)}`);
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

  errorLogPath = path.resolve(process.cwd(), 'errors.log');

  let inputStat;
  try {
    inputStat = await fs.stat(args.input);
  } catch (err) {
    console.error(
      chalk.red(
        `✗ Входная директория недоступна: ${args.input} (${err.message})`,
      ),
    );
    process.exit(1);
  }
  if (!inputStat.isDirectory()) {
    console.error(
      chalk.red(`✗ Входной путь не является директорией: ${args.input}`),
    );
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
  const allFiles = await collectAllFiles(args.input);
  const files = allFiles.filter((f) =>
    args.formats.has(path.extname(f).toLowerCase()),
  );
  const nonConvertible = allFiles.filter(
    (f) => !args.formats.has(path.extname(f).toLowerCase()),
  );
  stats.total = allFiles.length;

  console.log(
    chalk.green(`✓ Найдено изображений для конвертации: ${files.length}`),
  );
  if (nonConvertible.length > 0) {
    console.log(
      chalk.dim(`● Файлов не подлежащих конвертации: ${nonConvertible.length}`),
    );
  }
  console.log('');

  stats.startTime = performance.now();

  const totalWork = files.length + (args.output ? nonConvertible.length : 0);
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

  bar.start(totalWork, 0, {
    filename: '',
    rate: '0.00',
    etaFormatted: '--:--',
  });

  const limit = pLimit(args.concurrency);

  const tasks = [];

  // Конвертация изображений
  for (const file of files) {
    tasks.push(
      limit(async () => {
        if (interrupted) return;
        const target = resolveOutputPath(file, args.input, args.output);
        const relName = path.relative(args.input, file);

        const result = await convertFile(file, target, {
          quality: args.quality,
          lossless: args.lossless,
          effort: args.effort,
          maxWidth: args.maxWidth,
          skipExisting: args.skipExisting,
          keepOriginal: args.keepOriginal,
        });

        stats.bytesBefore += result.sizeBefore;
        stats.bytesAfter += result.sizeAfter;

        if (result.status === 'converted') {
          stats.converted += 1;
        } else if (result.status === 'skipped') {
          stats.skipped += 1;
        } else if (result.status === 'error') {
          stats.errors += 1;
          await logError(
            `Ошибка ${file}: ${result.error?.stack ?? result.error?.message ?? result.error}`,
          );
        }

        const elapsedSec = (performance.now() - stats.startTime) / 1000;
        const processed =
          stats.converted + stats.skipped + stats.errors + stats.copied;
        const rate =
          elapsedSec > 0 ? (processed / elapsedSec).toFixed(2) : '0.00';
        const remaining = totalWork - processed;
        const etaSec =
          elapsedSec > 0 && processed > 0
            ? (remaining * elapsedSec) / processed
            : 0;
        const etaFormatted =
          etaSec > 0 ? formatDuration(etaSec * 1000) : '--:--';

        bar.increment(1, {
          filename: relName.length > 50 ? `…${relName.slice(-49)}` : relName,
          rate,
          etaFormatted,
        });
      }),
    );
  }

  // Копирование файлов, которые не подлежат конвертации (если указан output)
  if (args.output && nonConvertible.length > 0) {
    for (const file of nonConvertible) {
      tasks.push(
        limit(async () => {
          if (interrupted) return;
          const target = resolveCopyPath(file, args.input, args.output);
          const relName = path.relative(args.input, file);
          if (!target) return;
          try {
            await ensureDir(path.dirname(target));
            await fs.copyFile(file, target);
            const st = await fs.stat(file);
            stats.bytesBefore += st.size;
            stats.bytesAfter += st.size;
            stats.copied += 1;
          } catch (err) {
            stats.errors += 1;
            await logError(
              `Не удалось скопировать ${file} -> ${target}: ${err.message}`,
            );
          }

          const elapsedSec = (performance.now() - stats.startTime) / 1000;
          const processed =
            stats.converted + stats.skipped + stats.errors + stats.copied;
          const rate =
            elapsedSec > 0 ? (processed / elapsedSec).toFixed(2) : '0.00';
          const remaining = totalWork - processed;
          const etaSec =
            elapsedSec > 0 && processed > 0
              ? (remaining * elapsedSec) / processed
              : 0;
          const etaFormatted =
            etaSec > 0 ? formatDuration(etaSec * 1000) : '--:--';

          bar.increment(1, {
            filename: relName.length > 50 ? `…${relName.slice(-49)}` : relName,
            rate,
            etaFormatted,
          });
        }),
      );
    }
  }

  await Promise.all(tasks);
  bar.stop();

  printSummary();
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
    if (stats.startTime) printSummary();
    process.exit(130);
  }, 500);
});

main().catch(async (err) => {
  console.error(
    chalk.red(`✗ Критическая ошибка: ${err.stack ?? err.message ?? err}`),
  );
  await logError(`Критическая ошибка: ${err.stack ?? err.message ?? err}`);
  process.exit(1);
});
