import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Изолированный in-memory SQLite на тест-процесс. Тесты не пишут в game.db.
    env: {
      DB_PATH:   ':memory:',
      DEV_MODE:  'true',     // mailer не пытается ходить в Resend
      NODE_ENV:  'test',
      ADMIN_KEY: 'test-admin-key',
    },
    // По одному воркеру — чтобы все тесты делили один in-memory DB,
    // который мы чистим в beforeEach. Так проще, чем плодить миграции.
    fileParallelism: false,
    pool: 'forks',
    forks: { singleFork: true },
  },
});
