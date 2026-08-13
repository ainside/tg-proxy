import type { Agent } from 'node:http';

export declare const TELEGRAM_HOST: 'api.telegram.org';
export declare const TELEGRAM_PORT: 443;

export interface ProbeResult {
  ok: boolean;
  /** Человекочитаемая причина отказа. */
  error?: string;
  /** Код ошибки сокета (ECONNREFUSED, ETIMEDOUT, …). */
  code?: string;
  /** HTTP-статус ответа прокси на CONNECT. */
  status?: number;
}

export interface WatchOptions {
  /** Период проверки, мс. 0 или меньше — сторож не запускается. */
  intervalMs?: number;
  /** Сколько подряд неудачных проверок считать потерей канала. */
  failuresBeforeLost?: number;
  onLost?: (info: { failures: number; error?: string }) => void;
  onRecovered?: () => void;
}

export interface Transport {
  /** proxy — трафик идёт через CONNECT-туннель, direct — напрямую. */
  mode: 'proxy' | 'direct';
  /** Агент для библиотеки бота. undefined = прямое соединение. */
  agent: Agent | undefined;
  proxyUrl: string | null;
  /** Адрес прокси без пароля — для логов. */
  maskedProxyUrl: string | null;
  describe(): string;
  /** Разовая проверка выбранного канала. */
  check(): Promise<ProbeResult>;
  /** Периодическая проверка канала. Возвращает функцию остановки. */
  watch(options?: WatchOptions): () => void;
}

export interface Logger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export interface TransportOptions {
  /**
   * Адрес прокси. Не задан — берётся из окружения
   * (TELEGRAM_PROXY_URL, TG_PROXY_URL, HTTPS_PROXY, https_proxy).
   * Пустая строка — прокси намеренно не используется.
   */
  url?: string;
  env?: NodeJS.ProcessEnv;
  /** Прокси не отвечает — работать напрямую (по умолчанию) или упасть. */
  fallbackToDirect?: boolean;
  /** Отключает проверку канала на старте: транспорт создаётся «вслепую». */
  probe?: boolean;
  /** Таймаут проверки канала, мс. На боевые запросы не влияет. */
  timeoutMs?: number;
  /** Опции http.Agent для прокси-агента. */
  agentOptions?: Record<string, unknown>;
  logger?: Logger;
}

export declare function resolveProxyUrl(
  env?: NodeJS.ProcessEnv,
): { url: string; source: string } | null;

export declare function maskProxyUrl(url: string): string;

export declare function probeProxy(options: {
  url: string;
  host?: string;
  port?: number;
  timeoutMs?: number;
}): Promise<ProbeResult>;

export declare function probeDirect(options?: {
  host?: string;
  port?: number;
  timeoutMs?: number;
}): Promise<ProbeResult>;

export declare function createProxyAgent(url: string, options?: Record<string, unknown>): Agent;

export declare function createTelegramTransport(options?: TransportOptions): Promise<Transport>;
