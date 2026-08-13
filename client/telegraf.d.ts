import type { Agent } from 'node:http';
import type { Transport } from './index';

interface TelegramLike {
  options: { agent?: Agent };
}

interface BotLike {
  telegram: TelegramLike;
}

/** Опции для `new Telegraf(token, options)` с агентом выбранного транспорта. */
export declare function telegrafOptions<T extends Record<string, unknown>>(
  transport: Transport | null | undefined,
  extra?: T,
): T & { telegram?: Record<string, unknown> };

/** Проставляет агент уже созданному боту. Только до launch(). */
export declare function applyToTelegraf<T extends BotLike | TelegramLike>(
  bot: T,
  transport: Transport | null | undefined,
): T;
