import Anthropic from '@anthropic-ai/sdk';

/**
 * Ленивый клиент Anthropic. Создаётся при первом обращении — модуль грузится
 * без ошибок даже когда ключ не задан (фича генерации просто отключена).
 *
 * Конфиг через env:
 *   ANTHROPIC_API_KEY — ключ API (обязателен, иначе getAnthropic() → null)
 *   ANTHROPIC_MODEL   — модель (опционально, по умолчанию claude-sonnet-4-5)
 */
export const ANTHROPIC_MODEL = process.env['ANTHROPIC_MODEL'] ?? 'claude-sonnet-4-5';

let _client: Anthropic | null = null;

/** Возвращает клиент Anthropic, либо null если ANTHROPIC_API_KEY не задан. */
export function getAnthropic(): Anthropic | null {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key) return null;
  if (!_client) _client = new Anthropic({ apiKey: key });
  return _client;
}
