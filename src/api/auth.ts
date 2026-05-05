import { Hono }    from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z }         from 'zod';
import { randomUUID } from 'crypto';
import { eq, lt, and, gt } from 'drizzle-orm';

import { db }        from '../shared/db.js';
import { users, sessions } from '../shared/schema.js';
import { logger }    from '../shared/logger.js';
import { sendOtpEmail } from './mailer.js';

// ── OTP-хранилище (in-memory, достаточно для MVP) ──────────────────────────────
// Для продакшна лучше хранить в Redis или отдельной таблице БД

interface OtpEntry {
  email:     string;
  code:      string;
  expiresAt: number;
  attempts:  number;
}

const otpStore = new Map<string, OtpEntry>();   // key = email
const OTP_TTL_MS    = 15 * 60 * 1000;           // 15 минут
const OTP_MAX_TRIES = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

// Чистим просроченные OTP раз в 5 минут
setInterval(() => {
  const now = Date.now();
  for (const [email, entry] of otpStore) {
    if (entry.expiresAt < now) otpStore.delete(email);
  }
}, 5 * 60 * 1000);

// ── Роуты ──────────────────────────────────────────────────────────────────────

const auth = new Hono();

// POST /auth/request  →  отправить OTP на email
auth.post('/request', zValidator('json', z.object({
  email: z.string().email().max(255),
  name:  z.string().min(1).max(32).optional(),
})), async (c) => {
  const { email, name } = c.req.valid('json');
  const normalEmail = email.toLowerCase().trim();

  // Генерируем 6-значный код
  const code = String(Math.floor(100_000 + Math.random() * 900_000));
  otpStore.set(normalEmail, { email: normalEmail, code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 });

  try {
    await sendOtpEmail(normalEmail, code);
  } catch (err) {
    logger.error('Failed to send OTP email', { email: normalEmail, err: String(err) });
    return c.json({ error: 'Не удалось отправить письмо. Попробуйте позже.' }, 500);
  }

  // Сохраняем имя пользователя для первичной регистрации
  if (name) {
    // Сохраним в OTP store как подсказку (если юзер не существует — используем имя при создании)
    (otpStore.get(normalEmail) as OtpEntry & { hint_name?: string })['hint_name'] = name;
  }

  logger.info('OTP requested', { email: normalEmail });
  return c.json({ ok: true, message: 'Код отправлен на почту' });
});

// POST /auth/verify  →  проверить OTP, вернуть session token
auth.post('/verify', zValidator('json', z.object({
  email: z.string().email().max(255),
  code:  z.string().length(6),
  name:  z.string().min(1).max(32).optional(),
})), async (c) => {
  const { email, code, name } = c.req.valid('json');
  const normalEmail = email.toLowerCase().trim();
  const entry = otpStore.get(normalEmail) as (OtpEntry & { hint_name?: string }) | undefined;

  if (!entry) {
    return c.json({ error: 'Код не найден или истёк. Запросите новый.' }, 400);
  }
  if (Date.now() > entry.expiresAt) {
    otpStore.delete(normalEmail);
    return c.json({ error: 'Код истёк. Запросите новый.' }, 400);
  }
  if (entry.attempts >= OTP_MAX_TRIES) {
    otpStore.delete(normalEmail);
    return c.json({ error: 'Слишком много попыток. Запросите новый код.' }, 429);
  }
  if (entry.code !== code) {
    entry.attempts++;
    return c.json({ error: 'Неверный код.' }, 400);
  }

  otpStore.delete(normalEmail);

  // Найти или создать пользователя
  let user = db.select().from(users).where(eq(users.email, normalEmail)).get();
  if (!user) {
    const displayName = name ?? entry.hint_name ?? normalEmail.split('@')[0] ?? 'Player';
    user = { id: randomUUID(), email: normalEmail, name: displayName, createdAt: Date.now() };
    db.insert(users).values(user).run();
    logger.info('new user registered', { id: user.id, email: normalEmail });
  }

  // Удаляем просроченные сессии этого юзера
  db.delete(sessions).where(and(eq(sessions.userId, user.id), lt(sessions.expiresAt, Date.now()))).run();

  // Создаём сессию
  const token = randomUUID();
  const now   = Date.now();
  db.insert(sessions).values({
    token,
    userId:    user.id,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  }).run();

  logger.info('session created', { userId: user.id, email: normalEmail });

  return c.json({
    ok:    true,
    token,
    user: { id: user.id, email: user.email, name: user.name },
  });
});

// POST /auth/logout  →  удалить сессию
auth.post('/logout', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (token) {
    db.delete(sessions).where(eq(sessions.token, token)).run();
  }
  return c.json({ ok: true });
});

// GET /auth/me  →  информация о текущем пользователе + продлеваем сессию (rolling TTL)
auth.get('/me', async (c) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);

  const now = Date.now();
  const session = db.select().from(sessions).where(eq(sessions.token, token)).get();
  if (!session || session.expiresAt < now) {
    return c.json({ error: 'Session expired' }, 401);
  }

  const user = db.select().from(users).where(eq(users.id, session.userId)).get();
  if (!user) return c.json({ error: 'User not found' }, 404);

  // Rolling session: продлеваем только если до истечения меньше 15 дней
  const renewThreshold = SESSION_TTL_MS / 2;   // 15 дней
  if (session.expiresAt - now < renewThreshold) {
    db.update(sessions)
      .set({ expiresAt: now + SESSION_TTL_MS })
      .where(eq(sessions.token, token))
      .run();
    logger.debug('session renewed', { userId: user.id });
  }

  return c.json({ id: user.id, email: user.email, name: user.name });
});

export { auth };
