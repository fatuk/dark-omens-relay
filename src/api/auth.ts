import { Hono }    from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z }         from 'zod';
import { randomUUID, randomInt } from 'crypto';
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

// ── Rate-limit на /auth/request ────────────────────────────────────────────────
// In-memory счётчик по email и IP. Окно 10 минут. Защита от:
//   - спама в почтовый ящик жертвы (письма стоят денег и портят репутацию)
//   - перевыпуска OTP в обход 5-попытки лимита на /verify (новый код сбрасывает
//     attempts), фактически давая злоумышленнику неограниченное число попыток
//     подобрать 6-значный код в ширину.
// На /verify лимит уже есть (OTP_MAX_TRIES внутри OtpEntry).
interface RateEntry { count: number; resetAt: number; }
const requestRate = new Map<string, RateEntry>();
const RATE_WINDOW_MS    = 10 * 60 * 1000;
const RATE_MAX_PER_EMAIL = 3;
const RATE_MAX_PER_IP    = 10;

// Чистим просроченные OTP и rate-counters раз в 5 минут.
setInterval(() => {
  const now = Date.now();
  for (const [email, entry] of otpStore) {
    if (entry.expiresAt < now) otpStore.delete(email);
  }
  for (const [k, v] of requestRate) {
    if (v.resetAt < now) requestRate.delete(k);
  }
}, 5 * 60 * 1000);

/**
 * Сбрасывает все rate-counters и OTP-store. Только для тестов — общий процесс
 * vitest накапливает счётчики между describe-блоками и упирается в лимит.
 */
export function __resetAuthStateForTests(): void {
  otpStore.clear();
  requestRate.clear();
}

/** Учитывает попытку. true — разрешено, false — лимит исчерпан. */
function bumpRate(key: string, limit: number): boolean {
  const now   = Date.now();
  const entry = requestRate.get(key);
  if (!entry || entry.resetAt < now) {
    requestRate.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

// ── Роуты ──────────────────────────────────────────────────────────────────────

const auth = new Hono();

// POST /auth/request  →  отправить OTP на email
auth.post('/request', zValidator('json', z.object({
  // trim+lowercase ДО .email(), иначе пробелы по бокам валятся как невалидный email
  email: z.string().trim().toLowerCase().pipe(z.string().email().max(255)),
  name:  z.string().min(1).max(32).optional(),
})), async (c) => {
  const { email, name } = c.req.valid('json');
  const normalEmail = email;   // уже нормализован валидатором

  // Rate-limit: атакующий иначе перевыпускает OTP бесконечно и подбирает
  // в ширину (новый код стирает attempts). Лимит per-email защищает почтовый
  // ящик жертвы, per-IP — общую пропускную способность.
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
          ?? c.req.header('x-real-ip')
          ?? 'unknown';
  const emailOk = bumpRate(`email:${normalEmail}`, RATE_MAX_PER_EMAIL);
  const ipOk    = bumpRate(`ip:${ip}`,             RATE_MAX_PER_IP);
  if (!emailOk || !ipOk) {
    logger.warn('OTP request rate-limited', { email: normalEmail, ip, emailOk, ipOk });
    return c.json({ error: 'Слишком много запросов. Попробуйте позже.' }, 429);
  }

  // 6-значный код из CSPRNG (crypto.randomInt). Math.random() для OTP
  // небезопасен — предсказуем и не приемлем для secret-материала.
  const code = String(randomInt(100_000, 1_000_000));
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
  email: z.string().trim().toLowerCase().pipe(z.string().email().max(255)),
  code:  z.string().length(6),
  name:  z.string().min(1).max(32).optional(),
})), async (c) => {
  const { email, code, name } = c.req.valid('json');
  const normalEmail = email;
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
