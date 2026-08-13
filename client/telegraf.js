'use strict';

// Тонкая обвязка над ядром для telegraf. Сам telegraf не импортируется —
// модуль не должен тянуть за собой конкретную библиотеку бота.

/**
 * Опции для `new Telegraf(token, options)`.
 *
 * attachmentAgent намеренно не выставляется: им telegraf качает файлы по
 * произвольным URL, а tg-proxy пропускает только api.telegram.org и ответит
 * на всё остальное 403.
 */
function telegrafOptions(transport, extra = {}) {
  if (!transport?.agent) return extra;

  return {
    ...extra,
    telegram: { ...(extra.telegram ?? {}), agent: transport.agent },
  };
}

/**
 * То же самое для уже созданного бота.
 *
 * Проба канала асинхронная, а обработчики обычно вешаются на инстанс, созданный
 * на верхнем уровне модуля — тогда агент проставляется здесь, до launch().
 * Вызывать строго до старта: агент читается при первом запросе.
 */
function applyToTelegraf(bot, transport) {
  const telegram = bot?.telegram ?? bot;
  if (!telegram?.options) {
    throw new TypeError('applyToTelegraf: ожидался экземпляр Telegraf или Telegram');
  }

  telegram.options.agent = transport?.agent;
  return bot;
}

module.exports = { applyToTelegraf, telegrafOptions };
