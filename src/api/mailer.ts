import nodemailer from 'nodemailer';
import { logger } from '../shared/logger.js';

const DEV_MODE = process.env['DEV_MODE'] === 'true' || process.env['NODE_ENV'] !== 'production';

// В DEV_MODE письма печатаются в консоль (не нужен SMTP)
const transporter = DEV_MODE
  ? null
  : nodemailer.createTransport({
      host:   process.env['SMTP_HOST']!,
      port:   parseInt(process.env['SMTP_PORT'] ?? '587', 10),
      secure: process.env['SMTP_SECURE'] === 'true',
      auth: {
        user: process.env['SMTP_USER']!,
        pass: process.env['SMTP_PASS']!,
      },
    });

const FROM = process.env['SMTP_FROM'] ?? 'Dark Omens <noreply@dark-omens.game>';

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

  if (DEV_MODE || !transporter) {
    logger.info(`[DEV] OTP email → ${to}`, { code });
    console.log(`\n📧  OTP для ${to}: ${code}\n`);
    return;
  }

  await transporter.sendMail({ from: FROM, to, subject, html });
  logger.info('OTP email sent', { to });
}
