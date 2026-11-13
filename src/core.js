import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import pLimit from 'p-limit';

/** Значения по умолчанию (совпадают с README). */
export const DEFAULTS = Object.freeze({
  quality: 80,
  lossless: false,
  effort: 4,
  keepOriginal: true,
  skipExisting: true,
  formats: 'jpg,jpeg,png,gif,tiff,bmp,avif',
  maxWidth: null,
  concurrency: os.cpus().length,
});

/**
 * Преобразует число байт в человекочитаемую строку (B, KB, MB, GB).
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(2)} ${units[i]}`;
}

/**
 * Форматирует длительность из миллисекунд в HH:MM:SS / MM:SS / SS.s.
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
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
 * Нормализует строку/массив/Set расширений в Set вида '.jpg'.
 * @param {string|string[]|Set<string>} formats
 * @returns {Set<string>}
 */
export function parseFormats(formats) {
  const list =
    typeof formats === 'string' ? formats.split(',') : [...(formats ?? [])];
  return new Set(
    list
      .map((s) => String(s).trim().toLowerCase())
      .filter(Boolean)
      .map((s) => (s.startsWith('.') ? s : `.${s}`)),
  );
}

/**
 * Дописывает строку в лог ошибок.
 * @param {string} logPath
 * @param {string} message
 */
export async function logError(logPath, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    await fs.appendFile(logPath, line, 'utf8');
  } catch {
    // Если лог не пишется — игнорируем, чтобы не уронить процесс.
  }
}

/**
 * Собирает все файлы (без фильтра по расширениям) рекурсивно.
 * @param {string} dir
 * @param {(msg: string) => Promise<void>} [onError]
 * @returns {Promise<string[]>}
 */
export async function collectAllFiles(dir, onError = async () => {}) {
  const result = [];

  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      await onError(
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
 * Возвращает путь, по которому должен быть сохранён результирующий .webp файл.
 * @param {string} sourceFile - абсолютный путь исходного файла
 * @param {string} inputRoot - корневая входная директория
 * @param {string|null} outputRoot - корневая выходная директория или null
 * @returns {string}
 */
export function resolveOutputPath(sourceFile, inputRoot, outputRoot) {
  const parsed = path.parse(sourceFile);
  if (!outputRoot) {
    return path.join(parsed.dir, `${parsed.name}.webp`);
  }
  const relativeDir = path.relative(inputRoot, parsed.dir);
  return path.join(outputRoot, relativeDir, `${parsed.name}.webp`);
}

/**
 * Путь для копирования не-конвертируемого файла в выходную директорию.
 * Если outputRoot === null, возвращает null.
 */
export function resolveCopyPath(sourceFile, inputRoot, outputRoot) {
  if (!outputRoot) return null;
  const parsed = path.parse(sourceFile);
  const relativeDir = path.relative(inputRoot, parsed.dir);
  return path.join(outputRoot, relativeDir, parsed.base);
}

/**
 * Конвертирует одно изображение в WebP.
 * @returns {Promise<{status: 'converted'|'skipped'|'error', sizeBefore: number, sizeAfter: number, error?: Error}>}
 */
export async function convertFile(sourceFile, targetFile, opts) {
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

  await fs.mkdir(path.dirname(targetFile), { recursive: true });

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
    const sizeAfter = (await fs.stat(targetFile)).size;

    if (!opts.keepOriginal) {
      // Удаляем оригинал только если результирующий файл лежит по другому пути,
      // чтобы случайно не удалить только что записанный .webp.
      if (path.resolve(sourceFile) !== path.resolve(targetFile)) {
        try {
          await fs.unlink(sourceFile);
        } catch (err) {
          await opts.onError?.(
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
 * Валидирует и нормализует параметры конвертации.
 * Бросает Error с понятным сообщением при некорректных значениях.
 * @param {object} raw
 */
export function normalizeOptions(raw) {
  const o = { ...DEFAULTS, ...raw };
  if (!o.input) throw new Error('не указана входная папка');
  const quality = Number(o.quality);
  const effort = Number(o.effort);
  const concurrency = Number(o.concurrency);
  const maxWidth =
    o.maxWidth === null || o.maxWidth === undefined || o.maxWidth === ''
      ? null
      : Number(o.maxWidth);

  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new Error('quality должен быть числом 1-100');
  }
  if (!Number.isInteger(effort) || effort < 0 || effort > 6) {
    throw new Error('effort должен быть числом 0-6');
  }
  if (maxWidth !== null && (!Number.isInteger(maxWidth) || maxWidth < 1)) {
    throw new Error('max-width должен быть положительным числом');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency должен быть положительным числом');
  }
  const formats = parseFormats(o.formats);
  if (formats.size === 0) throw new Error('не указаны форматы');

  return {
    input: path.resolve(o.input),
    output: o.output ? path.resolve(o.output) : null,
    quality,
    lossless: Boolean(o.lossless),
    effort,
    keepOriginal: Boolean(o.keepOriginal),
    skipExisting: Boolean(o.skipExisting),
    formats,
    maxWidth,
    concurrency,
  };
}

/**
 * Запускает конвертацию папки целиком.
 *
 * @param {ReturnType<typeof normalizeOptions>} args
 * @param {object} hooks
 * @param {string} hooks.errorLogPath - куда писать ошибки
 * @param {(info: {files: number, nonConvertible: number, totalWork: number}) => void} [hooks.onScan]
 * @param {(evt: {file: string, status: string, stats: object, totalWork: number}) => void} [hooks.onProgress]
 * @param {() => boolean} [hooks.isCancelled]
 * @returns {Promise<object>} итоговая статистика
 */
export async function runConversion(args, hooks) {
  const { errorLogPath, onScan, onProgress, isCancelled = () => false } =
    hooks;
  const onError = (msg) => logError(errorLogPath, msg);

  const inputStat = await fs.stat(args.input).catch((err) => {
    throw new Error(
      `Входная директория недоступна: ${args.input} (${err.message})`,
    );
  });
  if (!inputStat.isDirectory()) {
    throw new Error(`Входной путь не является директорией: ${args.input}`);
  }

  const stats = {
    total: 0,
    converted: 0,
    copied: 0,
    skipped: 0,
    errors: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    startTime: 0,
    elapsedMs: 0,
    cancelled: false,
  };

  const allFiles = await collectAllFiles(args.input, onError);
  // Не обходим выходную папку, если она лежит внутри входной.
  const outsideOutput = (f) =>
    !args.output || !path.resolve(f).startsWith(args.output + path.sep);
  const candidates = allFiles.filter(outsideOutput);
  const isImage = (f) => args.formats.has(path.extname(f).toLowerCase());
  const files = candidates.filter(isImage);
  const nonConvertible = candidates.filter((f) => !isImage(f));
  stats.total = candidates.length;

  const totalWork = files.length + (args.output ? nonConvertible.length : 0);
  onScan?.({ files: files.length, nonConvertible: nonConvertible.length, totalWork });

  stats.startTime = performance.now();
  const limit = pLimit(args.concurrency);

  const report = (file, status) => {
    stats.elapsedMs = performance.now() - stats.startTime;
    onProgress?.({
      file: path.relative(args.input, file),
      status,
      stats: { ...stats },
      totalWork,
    });
  };

  const tasks = files.map((file) =>
    limit(async () => {
      if (isCancelled()) return;
      const target = resolveOutputPath(file, args.input, args.output);
      const result = await convertFile(file, target, {
        quality: args.quality,
        lossless: args.lossless,
        effort: args.effort,
        maxWidth: args.maxWidth,
        skipExisting: args.skipExisting,
        keepOriginal: args.keepOriginal,
        onError,
      });

      stats.bytesBefore += result.sizeBefore;
      stats.bytesAfter += result.sizeAfter;

      if (result.status === 'converted') stats.converted += 1;
      else if (result.status === 'skipped') stats.skipped += 1;
      else {
        stats.errors += 1;
        await onError(
          `Ошибка ${file}: ${result.error?.stack ?? result.error?.message ?? result.error}`,
        );
      }
      report(file, result.status);
    }),
  );

  // Копирование файлов, которые не подлежат конвертации (если указан output)
  if (args.output) {
    for (const file of nonConvertible) {
      tasks.push(
        limit(async () => {
          if (isCancelled()) return;
          const target = resolveCopyPath(file, args.input, args.output);
          let status = 'copied';
          try {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(file, target);
            const st = await fs.stat(file);
            stats.bytesBefore += st.size;
            stats.bytesAfter += st.size;
            stats.copied += 1;
          } catch (err) {
            status = 'error';
            stats.errors += 1;
            await onError(
              `Не удалось скопировать ${file} -> ${target}: ${err.message}`,
            );
          }
          report(file, status);
        }),
      );
    }
  }

  await Promise.all(tasks);
  stats.elapsedMs = performance.now() - stats.startTime;
  stats.cancelled = isCancelled();
  return stats;
}
