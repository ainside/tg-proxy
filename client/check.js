#!/usr/bin/env node
'use strict';

// Диагностика канала до Telegram: `node client/check.js` (или npx tg-proxy-check).
//
// Берёт адрес прокси из окружения либо из первого аргумента, выбирает канал и
// делает по нему настоящий вызов Bot API с заведомо неверным токеном. Ответ
// `{"ok":false,"error_code":404}` доказывает, что туннель ведёт именно в Bot API,
// а не в подменяющий трафик nginx провайдера. Настоящий токен для этого не нужен.

const https = require('node:https');
const { createTelegramTransport, TELEGRAM_HOST } = require('./index');

const PROBE_PATH = '/bot0:INVALID-TOKEN/getMe';

function fetchProbe(agent, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get({ host: TELEGRAM_HOST, path: PROBE_PATH, agent }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () =>
        resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });

    request.setTimeout(timeoutMs, () => request.destroy(new Error(`нет ответа за ${timeoutMs} мс`)));
    request.on('error', reject);
  });
}

async function main() {
  const url = process.argv[2];
  const transport = await createTelegramTransport({
    ...(url ? { url } : {}),
    logger: { info: (m) => console.log(m), warn: (m) => console.warn(m) },
  });

  console.log(`Канал: ${transport.describe()}`);

  const { status, body } = await fetchProbe(transport.agent, 10_000);
  console.log(`GET https://${TELEGRAM_HOST}${PROBE_PATH} → ${status} ${body.trim().slice(0, 160)}`);

  let answer;
  try {
    answer = JSON.parse(body);
  } catch {
    answer = null;
  }

  if (answer?.ok === false) {
    console.log('Bot API отвечает — канал рабочий.');
    return;
  }

  console.warn('Ответ не похож на Bot API — проверьте, куда на самом деле ведёт туннель.');
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
