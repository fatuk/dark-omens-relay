import { defineConfig } from 'vitest/config';
import { tmpdir } from 'os';
import { join } from 'path';

export default defineConfig({
  test: {
    // Изолированный in-memory SQLite на тест-процесс. Тесты не пишут в game.db.
    env: {
      DB_PATH:   ':memory:',
      // LOG_DIR в tmpdir, чтобы не мусорить в проектный logs/ (там лежат
      // боевые логи from `npm run dev`). Logger импортируется до vitest env'а
      // в некоторых модулях — фолбэк в logger.ts перехватывает ENOENT, так
      // что хуже не будет, но указание явное.
      LOG_DIR:   join(tmpdir(), 'dark-omens-relay-test-logs'),
      DEV_MODE:  'true',     // mailer не пытается ходить в Resend
      NODE_ENV:  'test',
      ADMIN_KEY: 'test-admin-key',
    },
    // По одному воркеру — чтобы все тесты делили один in-memory DB,
    // который мы чистим в beforeEach. Так проще, чем плодить миграции.
    fileParallelism: false,
    pool: 'forks',
    forks: { singleFork: true },
    coverage: {
      provider:  'v8',
      reporter:  ['text', 'lcov'],
      include:   ['src/**/*.ts'],
      exclude:   [
        'src/**/server.ts',
        'src/api/anthropic.ts',
        'src/api/mailer.ts',
        // Шаблоны промптов — текстовая склейка под LLM. Снапшот-тесты
        // имеют смысл, юнит-покрытие — нет; пока выводим из расчёта.
        'src/api/encounter-prompt.ts',
        'src/api/campaign-prompt.ts',
        'src/api/effect-dsl.ts',
        // env.ts — boot-time чтение process.env, без полезных веток.
        'src/shared/env.ts',
      ],
      thresholds: {
        // Минимальный пол — чуть ниже текущего реального покрытия, чтобы
        // регрессия (удаление тестов / новый непокрытый код) ловилась в CI.
        // Поднимаем по мере добавления тестов.
        statements: 70,
        branches:   60,
        functions:  65,
        lines:      70,
      },
    },
  },
});
