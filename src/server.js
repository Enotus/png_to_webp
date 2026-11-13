#!/usr/bin/env node

import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, normalizeOptions, runConversion } from './core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, '..', 'web');
const IMAGES_DIR = path.join(PROJECT_ROOT, 'images');
const ERROR_LOG = path.join(PROJECT_ROOT, 'errors.log');

const PORT = Number(process.env.PORT) || 5173;
// Сервер имеет доступ к файловой системе — слушаем только localhost.
const HOST = '127.0.0.1';

/** Значения по умолчанию для UI: как в README, но quality = 90. */
const UI_DEFAULTS = {
  ...DEFAULTS,
  quality: 90,
  maxWidth: '',
};

/**
 * Текущая задача (одновременно выполняется только одна).
 * @type {null | {id: number, state: string, args: object, cancelled: boolean, scan?: object, last?: object, result?: object, error?: string, recent: object[]}}
 */
let job = null;
let jobSeq = 0;

/** Подписчики SSE. */
const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
}

function publicJob() {
  if (!job) return null;
  return {
    id: job.id,
    state: job.state,
    input: job.args.input,
    output: job.args.output,
    scan: job.scan ?? null,
    last: job.last ?? null,
    result: job.result ?? null,
    error: job.error ?? null,
    recent: job.recent,
  };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/** Раскрывает ~ и делает путь абсолютным. */
function expandPath(p) {
  if (!p) return p;
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(PROJECT_ROOT, p);
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ─── Обработчики API ────────────────────────────────────────────────────────

async function handleDefaults(res) {
  const startDir = (await exists(IMAGES_DIR)) ? IMAGES_DIR : PROJECT_ROOT;
  sendJson(res, 200, {
    defaults: UI_DEFAULTS,
    cpus: os.cpus().length,
    startDir,
    home: os.homedir(),
    projectRoot: PROJECT_ROOT,
    job: publicJob(),
  });
}

async function handleBrowse(res, url) {
  const target = expandPath(url.searchParams.get('path') || IMAGES_DIR);
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (err) {
    return sendJson(res, 400, { error: `Не удалось открыть ${target}: ${err.message}` });
  }
  const formats = new Set(
    DEFAULTS.formats.split(',').map((e) => `.${e}`),
  );
  const dirs = [];
  let images = 0;
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile() && formats.has(path.extname(e.name).toLowerCase())) images += 1;
  }
  dirs.sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
  const parent = path.dirname(target);
  sendJson(res, 200, {
    path: target,
    parent: parent === target ? null : parent,
    dirs,
    images,
  });
}

async function handleConvert(req, res) {
  if (job && (job.state === 'scanning' || job.state === 'running')) {
    return sendJson(res, 409, { error: 'Конвертация уже идёт' });
  }
  let args;
  try {
    const body = await readBody(req);
    args = normalizeOptions({
      ...body,
      input: expandPath(body.input),
      output: body.output ? expandPath(body.output) : null,
    });
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  if (args.output && args.output === args.input) {
    return sendJson(res, 400, { error: 'Выходная папка совпадает с исходной' });
  }

  const current = {
    id: ++jobSeq,
    state: 'scanning',
    args,
    cancelled: false,
    recent: [],
  };
  job = current;
  broadcast('job', publicJob());
  sendJson(res, 202, { id: current.id });

  let lastBroadcast = 0;
  try {
    const result = await runConversion(args, {
      errorLogPath: ERROR_LOG,
      isCancelled: () => current.cancelled,
      onScan: (scan) => {
        current.scan = scan;
        current.state = 'running';
        broadcast('job', publicJob());
      },
      onProgress: (evt) => {
        current.last = { ...evt.stats, file: evt.file };
        current.recent.unshift({ file: evt.file, status: evt.status });
        current.recent.length = Math.min(current.recent.length, 50);
        // Не чаще ~15 раз в секунду, чтобы не заваливать браузер.
        const now = Date.now();
        if (now - lastBroadcast > 66) {
          lastBroadcast = now;
          broadcast('job', publicJob());
        }
      },
    });
    current.result = result;
    current.state = result.cancelled ? 'cancelled' : 'done';
  } catch (err) {
    current.state = 'error';
    current.error = err.message;
  }
  broadcast('job', publicJob());
}

function handleCancel(res) {
  if (job && (job.state === 'scanning' || job.state === 'running')) {
    job.cancelled = true;
    job.state = 'cancelling';
    broadcast('job', publicJob());
  }
  sendJson(res, 200, { ok: true });
}

async function handleReveal(req, res) {
  const { path: p } = await readBody(req).catch(() => ({}));
  const target = expandPath(p);
  if (!target || !(await exists(target))) {
    return sendJson(res, 404, { error: 'Папка не найдена' });
  }
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'explorer'
        : 'xdg-open';
  spawn(cmd, [target], { detached: true, stdio: 'ignore' }).unref();
  sendJson(res, 200, { ok: true });
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`event: job\ndata: ${JSON.stringify(publicJob())}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

async function serveStatic(res, pathname) {
  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
  };
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

// ─── Сервер ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;
  try {
    switch (route) {
      case 'GET /api/defaults':
        return await handleDefaults(res);
      case 'GET /api/browse':
        return await handleBrowse(res, url);
      case 'POST /api/convert':
        return await handleConvert(req, res);
      case 'POST /api/cancel':
        return handleCancel(res);
      case 'POST /api/reveal':
        return await handleReveal(req, res);
      case 'GET /api/events':
        return handleEvents(req, res);
      default:
        if (req.method === 'GET') return await serveStatic(res, url.pathname);
        res.writeHead(405).end();
    }
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`WebP converter UI: http://localhost:${PORT}`);
});
