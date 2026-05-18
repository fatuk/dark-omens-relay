import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Подгружает `.env` из корня проекта в `process.env`.
 *
 * Side-effect модуль: импортируется ПЕРВОЙ строкой в server.ts, чтобы значения
 * успели появиться до того, как другие модули прочитают `process.env` на этапе
 * загрузки (mailer.ts, anthropic.ts и т.п.).
 *
 * Уже заданные НЕПУСТЫЕ переменные НЕ перезатираются — в проде их выставляет
 * PM2 через `ecosystem.config.cjs`, и они должны иметь приоритет над файлом.
 * Переменная, заданная пустой строкой, считается незаданной (её значение из
 * `.env` подставляется) — иначе пустой ANTHROPIC_API_KEY из окружения молча
 * заблокировал бы реальный ключ из файла.
 */
const ENV_PATH = join(process.cwd(), '.env');

if (existsSync(ENV_PATH)) {
  for (const raw of readFileSync(ENV_PATH, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    let val   = line.slice(eq + 1).trim();

    // Снимаем обрамляющие кавычки, если есть.
    if (val.length >= 2 &&
        ((val.startsWith('"') && val.endsWith('"')) ||
         (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }

    if (key && !process.env[key]) {
      process.env[key] = val;
    }
  }
}
