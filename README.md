# tg-proxy

Две половины одного решения — как боту в закрытой сети ходить в Telegram:

- **сервер** (`proxy-server.js`) — форвард-прокси на VPS, туннель до `api.telegram.org`;
- **клиент** (`client/`) — npm-модуль для бота: выбирает канал и отдаёт готовый `http.Agent`.

## Сервер

Минималистичный forward-прокси без зависимостей (только встроенные модули Node.js
`http`/`net`/`crypto`), который туннелирует HTTPS к `api.telegram.org` через метод
HTTP `CONNECT`.

Гарантии:

- Обрабатывает **только** `CONNECT` (обычные GET/POST → `405`).
- Требует **Basic-авторизацию** (`Proxy-Authorization`) по `PROXY_USER` / `PROXY_PASS`.
- Whitelist **только** `api.telegram.org:443` (любой другой host → `403`) — не может стать
  открытым релеем.

## Конфигурация

Настройки берутся из `.env` (в .gitignore) или из окружения:

```
PROXY_USER=tgproxy
PROXY_PASS=<стойкий случайный пароль>
PROXY_PORT=8888
```

### Запуск

Серверу зависимости не нужны — `npm install` делать не обязательно.

```bash
node proxy-server.js
```

Слушает `0.0.0.0:PROXY_PORT`. Каждый запрос логируется в stdout в формате
`<ISO-timestamp> <client-ip> <ALLOW|DENY> <reason>`.

### Локальная проверка

```bash
# Успешный сценарий — любой ответ Telegram означает, что туннель отработал:
curl -x "http://tgproxy:<PASS>@127.0.0.1:8888" https://api.telegram.org/bot0:INVALID/getMe

# Негативные проверки:
curl -x http://127.0.0.1:8888 https://api.telegram.org/              # -> 407 (нет креденшлов)
curl -x "http://tgproxy:<PASS>@127.0.0.1:8888" https://example.com/  # -> 403 (host не разрешён)
curl http://127.0.0.1:8888/                                          # -> 405 (не CONNECT)
```

Адрес прокси для бота:

```
http://tgproxy:<PASS>@<адрес_сервера>:8888
```

## Клиент для ботов

Ставится прямо из этого репозитория:

```bash
npm i github:ainside/tg-proxy
```

Адрес прокси берётся из окружения — первая непустая переменная из
`TELEGRAM_PROXY_URL`, `TG_PROXY_URL`, `HTTPS_PROXY`, `https_proxy`:

```
TELEGRAM_PROXY_URL=http://tgproxy:<PASS>@<адрес_сервера>:8888
```

Пусто — значит бот ходит в Telegram напрямую. Один и тот же код работает и там,
где прокси нужен, и там, где нет.

### Как работает

1. До старта бота делается настоящий `CONNECT` через прокси. Это сразу отсекает
   неверный пароль (`407`), не тот хост (`403`), мёртвый прокси (`ECONNREFUSED`)
   и недоступный с той стороны Telegram (`502`).
2. Прокси не отвечает — проверяется прямое соединение, и бот работает без прокси
   с предупреждением в лог (`fallbackToDirect: false` — падать вместо этого).
3. Не работает ни то ни другое — исключение с обеими причинами.

### Telegraf

```js
const { createTelegramTransport } = require('tg-proxy');
const { telegrafOptions } = require('tg-proxy/telegraf');

const transport = await createTelegramTransport();
const bot = new Telegraf(token, telegrafOptions(transport));
```

Если бот создаётся на верхнем уровне модуля (обработчики уже навешаны), агент
проставляется готовому инстансу — строго до `launch()`:

```js
const { applyToTelegraf } = require('tg-proxy/telegraf');
applyToTelegraf(bot, await createTelegramTransport());
```

### Другие библиотеки

Ядро отдаёт обычный `http.Agent`, его принимают все:

```js
const transport = await createTelegramTransport();

new Bot(token, { client: { baseFetchConfig: { agent: transport.agent } } }); // grammY
new TelegramBot(token, { request: { agent: transport.agent } });             // node-telegram-bot-api
```

`transport.agent === undefined` — это прямое соединение, библиотеки понимают
такой агент как «настроек нет».

### Обрыв прокси на ходу

При long polling обрыв канала не роняет бота: библиотека молча уходит в
бесконечные ретраи, и бот перестаёт получать обновления, оставаясь «живым».
Сторож проверяет канал и сообщает о потере — дальше решает приложение
(обычно: залогировать и выйти, чтобы супервизор перезапустил процесс и проба
выбрала канал заново).

```js
const stop = transport.watch({
  intervalMs: 60_000,
  failuresBeforeLost: 3,
  onLost: ({ error }) => {
    console.error(`Канал до Telegram потерян: ${error}`);
    process.exit(1);
  },
});
```

### Диагностика

```bash
npx tg-proxy-check                                  # канал из окружения
npx tg-proxy-check http://user:pass@host:8888       # конкретный прокси
```

Печатает выбранный канал и делает по нему реальный вызов Bot API с заведомо
неверным токеном: ответ `{"ok":false,...}` доказывает, что на том конце
настоящий Bot API, а не подменяющий трафик nginx. Настоящий токен не нужен.

### API

| Экспорт | Назначение |
| --- | --- |
| `createTelegramTransport(options)` | Проба канала и выбор режима → `Transport` |
| `probeProxy({ url })` / `probeDirect()` | Разовые пробы без создания транспорта |
| `createProxyAgent(url)` | Агент без всяких проб |
| `resolveProxyUrl(env)` | Адрес прокси из окружения |
| `maskProxyUrl(url)` | URL без пароля — для логов |
| `tg-proxy/telegraf` | `telegrafOptions(transport)`, `applyToTelegraf(bot, transport)` |

Опции `createTelegramTransport`: `url`, `env`, `fallbackToDirect` (по умолчанию
`true`), `probe`, `timeoutMs` (таймаут пробы; на боевые запросы не влияет),
`agentOptions`, `logger`.

## Деплой (отложено — в текущей сессии не выполнялся)

Выполнить на целевом **Linux**-сервере при деплое:

```bash
# Менеджер процессов + автозапуск при ребуте
npm i -g pm2                         # если pm2 ещё не установлен
pm2 start proxy-server.js --name tg-proxy
pm2 save
pm2 startup                          # выполнить команду из вывода для автозапуска через systemd

# Firewall: открыть порт только для ОДНОГО конкретного IP — никогда не для всего интернета.
# Замените <ALLOWED_IP> на IP клиента, которому разрешён доступ к прокси.
ufw allow from <ALLOWED_IP> to any port 8888 proto tcp
# НЕ выполнять: ufw allow 8888   (это откроет прокси для всего интернета)
```

Эквивалент для Windows firewall:

```powershell
New-NetFirewallRule -DisplayName "tg-proxy" -Direction Inbound -Protocol TCP `
  -LocalPort 8888 -RemoteAddress <ALLOWED_IP> -Action Allow
```
