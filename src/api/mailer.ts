import { Resend } from 'resend';
import { logger } from '../shared/logger.js';

const DEV_MODE = process.env['DEV_MODE'] === 'true' || process.env['NODE_ENV'] !== 'production';

const resend = DEV_MODE ? null : new Resend(process.env['RESEND_API_KEY']);

const FROM = process.env['EMAIL_FROM'] ?? 'Dark Omens <noreply@dark-omens.game>';

// ── DEV: последние OTP-коды (только в DEV_MODE) ───────────────────────────────
interface DevOtpEntry { email: string; code: string; sentAt: string }
const _devOtpLog: DevOtpEntry[] = [];

export function getDevOtpLog(): DevOtpEntry[] {
  return _devOtpLog;
}

export async function sendOtpEmail(to: string, code: string): Promise<void> {
  const subject = 'Dark Omens — Ваш код входа';
  const html = `
    <div style="font-family:monospace;background:#0d0b18;color:#d4cfc0;padding:32px;max-width:480px">
      <h2 style="color:#c7a84a;margin-bottom:16px">⚔ Dark Omens</h2>
      <p style="margin-bottom:24px">Ваш одноразовый код для входа:</p>
      <div style="font-size:36px;letter-spacing:12px;color:#4db870;font-weight:bold;margin-bottom:24px">${code}</div>
      <p style="color:#7a7060;font-size:12px">Код действителен 15 минут. Если вы не запрашивали код — просто проигнорируйте это письмо.</p>
    </div>
  `;

  // Код всегда фиксируем в кольце последних 20 — для отладочного просмотра
  // через /dev/otp (нужно тестировщикам, пока нет верифицированного домена).
  _devOtpLog.unshift({ email: to, code, sentAt: new Date().toISOString() });
  if (_devOtpLog.length > 20) _devOtpLog.pop();

  if (DEV_MODE || !resend) {
    logger.info(`[DEV] OTP email → ${to}`, { code });
    console.log(`\n📧  OTP для ${to}: ${code}   →   /dev/otp\n`);
    return;
  }

  const { error } = await resend.emails.send({ from: FROM, to, subject, html });
  if (error) throw new Error(error.message);
  logger.info('OTP email sent', { to });
}
