# tg-proxy

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

## Запуск

```bash
node proxy-server.js
```

Слушает `0.0.0.0:PROXY_PORT`. Каждый запрос логируется в stdout в формате
`<ISO-timestamp> <client-ip> <ALLOW|DENY> <reason>`.

## Локальная проверка

```bash
# Успешный сценарий — тело ответа "404 / method not found" означает, что туннель отработал:
curl -x "http://tgproxy:<PASS>@127.0.0.1:8888" https://api.telegram.org/

# Негативные проверки:
curl -x http://127.0.0.1:8888 https://api.telegram.org/              # -> 407 (нет креденшлов)
curl -x "http://tgproxy:<PASS>@127.0.0.1:8888" https://example.com/  # -> 403 (host не разрешён)
curl http://127.0.0.1:8888/                                          # -> 405 (не CONNECT)
```

Указать прокси боту Telegram:

```
http://tgproxy:<PASS>@<адрес_сервера>:8888
```

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
