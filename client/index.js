'use strict';

// Клиентская половина tg-proxy: выбирает канал до api.telegram.org и отдаёт
// готовый http.Agent для любой библиотеки ботов (telegraf, grammy, node-telegram-bot-api).
//
// Логика одна на все проекты:
//   1. Взять адрес прокси из окружения (или из аргумента).
//   2. Проверить его настоящим CONNECT-запросом ДО старта бота.
//   3. Прокси не отвечает — при fallbackToDirect проверить прямое соединение
//      и работать без прокси, иначе упасть с внятной ошибкой.
//
// Модуль ничего не знает о конкретной библиотеке: см. ./telegraf для хелперов.

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { HttpsProxyAgent } = require('https-proxy-agent');

const TELEGRAM_HOST = 'api.telegram.org';
const TELEGRAM_PORT = 443;

/** Проба канала — быстрая операция, в отличие от долгого getUpdates. */
const DEFAULT_PROBE_TIMEOUT_MS = 7_000;

/** Переменные окружения в порядке приоритета. */
const ENV_KEYS = ['TELEGRAM_PROXY_URL', 'TG_PROXY_URL', 'HTTPS_PROXY', 'https_proxy'];

// ─── Конфигурация ───────────────────────────────────────────────────────────

/**
 * Адрес прокси из окружения. Пустая строка = «прокси не нужен», это не ошибка:
 * так проект с одним и тем же кодом работает и там, где Telegram доступен напрямую.
 */
function resolveProxyUrl(env = process.env) {
  for (const key of ENV_KEYS) {
    const value = (env[key] || '').trim();
    if (value) return { url: value, source: key };
  }
  return null;
}

/** URL прокси с вырезанным паролем — всё, что можно писать в лог. */
function maskProxyUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '<некорректный URL>';
  }
}

function parseProxyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Некорректный адрес прокси: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Прокси ${maskProxyUrl(url)}: поддерживается только http/https (метод CONNECT), ` +
        `получено «${parsed.protocol}»`,
    );
  }

  return parsed;
}

/** Заголовок Basic-авторизации прокси — ровно то, что ждёт proxy-server.js. */
function proxyAuthHeader(parsed) {
  if (!parsed.username && !parsed.password) return null;
  const credentials = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

// ─── Пробы канала ───────────────────────────────────────────────────────────

/**
 * Открывает CONNECT-туннель и сразу его закрывает.
 *
 * Проверяет всё сразу: прокси жив, креденшлы приняты (иначе 407), хост в
 * whitelist (иначе 403), сам Telegram доступен с той стороны (иначе 502).
 */
function probeProxy(options = {}) {
  const {
    url,
    host = TELEGRAM_HOST,
    port = TELEGRAM_PORT,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  } = options;

  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = parseProxyUrl(url);
    } catch (e) {
      resolve({ ok: false, error: e.message });
      return;
    }

    const headers = { Host: `${host}:${port}` };
    const auth = proxyAuthHeader(parsed);
    if (auth) headers['Proxy-Authorization'] = auth;

    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.request({
      host: parsed.hostname,
      port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      timeout: timeoutMs,
    });

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    request.once('connect', (response, socket) => {
      socket.destroy();
      finish(
        response.statusCode === 200
          ? { ok: true }
          : {
              ok: false,
              status: response.statusCode,
              error: describeProxyStatus(response.statusCode, response.statusMessage),
            },
      );
    });

    request.once('timeout', () => {
      request.destroy();
      finish({ ok: false, error: `прокси не ответил за ${timeoutMs} мс` });
    });

    request.once('error', (e) => finish({ ok: false, error: e.message, code: e.code }));

    request.end();
  });
}

/** Расшифровка кодов, которые возвращает proxy-server.js. */
function describeProxyStatus(status, statusMessage) {
  if (status === 407) return 'прокси отклонил логин/пароль (407)';
  if (status === 403) return `хост не в whitelist прокси (403)`;
  if (status === 405) return 'прокси не поддерживает CONNECT (405)';
  if (status === 502) return 'прокси не смог достучаться до Telegram (502)';
  return `прокси ответил ${status}${statusMessage ? ` ${statusMessage}` : ''}`;
}

/** Проба прямого соединения: TCP до Telegram, без TLS-рукопожатия. */
function probeDirect(options = {}) {
  const {
    host = TELEGRAM_HOST,
    port = TELEGRAM_PORT,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  } = options;

  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: `нет ответа за ${timeoutMs} мс` }));
    socket.once('connect', () => finish({ ok: true }));
    socket.once('error', (e) => finish({ ok: false, error: e.message, code: e.code }));
  });
}

// ─── Агент ──────────────────────────────────────────────────────────────────

/**
 * Агент для запросов к Bot API через прокси.
 *
 * Намеренно без опции `timeout`: getUpdates в режиме long polling держит
 * соединение десятками секунд, таймаут на сокете обрывал бы его на ровном месте.
 */
function createProxyAgent(url, options = {}) {
  const { keepAlive = true, ...rest } = options;
  return new HttpsProxyAgent(parseProxyUrl(url), { keepAlive, ...rest });
}

// ─── Транспорт ──────────────────────────────────────────────────────────────

/**
 * Выбирает канал до Telegram и возвращает описание транспорта.
 *
 * @returns {Promise<Transport>} agent === undefined означает прямое соединение —
 *   именно это и надо отдавать библиотеке бота, чтобы она работала как обычно.
 */
async function createTelegramTransport(options = {}) {
  const {
    env = process.env,
    fallbackToDirect = true,
    probe = true,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    agentOptions,
    logger = console,
  } = options;

  const fromEnv = options.url === undefined ? resolveProxyUrl(env) : null;
  const url = (options.url === undefined ? fromEnv?.url : options.url) || '';
  const source = fromEnv?.source ?? 'аргумент url';

  if (!url) {
    if (probe) {
      const direct = await probeDirect({ timeoutMs });
      if (!direct.ok) {
        throw new Error(
          `Telegram недоступен напрямую (${direct.error}), а прокси не задан ` +
            `(${ENV_KEYS[0]} пустой).`,
        );
      }
    }
    return makeTransport({ mode: 'direct', agent: undefined, url: null, timeoutMs });
  }

  const masked = maskProxyUrl(url);

  if (!probe) {
    return makeTransport({ mode: 'proxy', agent: createProxyAgent(url, agentOptions), url, timeoutMs });
  }

  const viaProxy = await probeProxy({ url, timeoutMs });
  if (viaProxy.ok) {
    logger.info?.(`Telegram через прокси ${masked} (${source})`);
    return makeTransport({ mode: 'proxy', agent: createProxyAgent(url, agentOptions), url, timeoutMs });
  }

  if (!fallbackToDirect) {
    throw new Error(`Прокси ${masked} недоступен: ${viaProxy.error}`);
  }

  const direct = await probeDirect({ timeoutMs });
  if (!direct.ok) {
    throw new Error(
      `Нет связи с Telegram: прокси ${masked} — ${viaProxy.error}; напрямую — ${direct.error}`,
    );
  }

  logger.warn?.(`Прокси ${masked} недоступен (${viaProxy.error}) — работаю напрямую`);
  return makeTransport({ mode: 'direct', agent: undefined, url, timeoutMs });
}

function makeTransport({ mode, agent, url, timeoutMs }) {
  const masked = url ? maskProxyUrl(url) : null;

  const check = () =>
    mode === 'proxy' ? probeProxy({ url, timeoutMs }) : probeDirect({ timeoutMs });

  return {
    mode,
    agent,
    proxyUrl: url || null,
    maskedProxyUrl: masked,
    describe: () => (mode === 'proxy' ? `через прокси ${masked}` : 'напрямую, без прокси'),
    check,
    watch: (watchOptions = {}) => watchChannel(check, watchOptions),
  };
}

/**
 * Периодически проверяет выбранный канал.
 *
 * Нужен потому, что при обрыве прокси long polling молча уходит в бесконечные
 * ретраи: бот «жив», но обновлений не получает. Что делать при потере канала —
 * решает вызывающий код (обычно: залогировать и выйти, чтобы супервизор
 * перезапустил процесс и проба выбрала канал заново).
 */
function watchChannel(check, options = {}) {
  const { intervalMs = 60_000, failuresBeforeLost = 3, onLost, onRecovered } = options;
  if (intervalMs <= 0) return () => undefined;

  let failures = 0;
  let lost = false;
  let stopped = false;

  const timer = setInterval(async () => {
    const result = await check();
    if (stopped) return;

    if (result.ok) {
      if (lost) {
        lost = false;
        onRecovered?.();
      }
      failures = 0;
      return;
    }

    failures += 1;
    if (failures >= failuresBeforeLost && !lost) {
      lost = true;
      onLost?.({ failures, error: result.error });
    }
  }, intervalMs);

  // Сторожевой таймер не должен сам по себе держать процесс живым.
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = {
  TELEGRAM_HOST,
  TELEGRAM_PORT,
  createProxyAgent,
  createTelegramTransport,
  maskProxyUrl,
  probeDirect,
  probeProxy,
  resolveProxyUrl,
};
