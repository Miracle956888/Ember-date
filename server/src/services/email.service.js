import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('email');
let transporter = null;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function getTransport() {
  if (!env.SMTP.configured) return null;
  if (env.SMTP.user && !env.SMTP.password) {
    throw new Error('SMTP_PASSWORD is required when SMTP_USER is set.');
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP.host,
      port: env.SMTP.port,
      secure: env.SMTP.secure,
      requireTLS: !env.SMTP.secure,
      ...(env.SMTP.user ? { auth: { user: env.SMTP.user, pass: env.SMTP.password } } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      logger: false,
      debug: false
    });
  }
  return transporter;
}

async function send(message, category) {
  let mailer;
  try {
    mailer = getTransport();
  } catch (error) {
    log.error('email delivery is misconfigured', { category, code: error.message });
    return { sent: false, reason: 'configuration' };
  }
  if (!mailer) {
    log.warn('email delivery is not configured', { category });
    return { sent: false, reason: 'not_configured' };
  }

  try {
    await mailer.sendMail({ from: env.SMTP.from, ...message });
    return { sent: true };
  } catch (error) {
    // Do not include recipients, message content, reset URLs, codes, or SMTP
    // credentials in logs. The stable error code is enough for operations.
    log.error('email delivery failed', { category, code: error.code || 'SMTP_ERROR' });
    return { sent: false, reason: 'provider_error' };
  }
}

export async function sendPasswordReset({ to, displayName, token }) {
  const link = new URL('/reset-password', env.APP_ORIGIN);
  // Hash fragments are not sent in HTTP requests or Referer headers, so the
  // bearer token never appears in web-server access logs.
  link.hash = `token=${encodeURIComponent(token)}`;
  const name = displayName ? ` ${displayName}` : '';
  const url = link.toString();
  const safeName = escapeHtml(name);
  const safeUrl = escapeHtml(url);

  return send({
    to,
    subject: 'Reset your Ember password',
    text: `Hello${name},\n\nUse this one-time link within 30 minutes to reset your Ember password:\n${url}\n\nIf you did not request this, you can ignore this message.`,
    html: `<p>Hello${safeName},</p><p>Use this one-time link within 30 minutes to reset your Ember password:</p><p><a href="${safeUrl}">Reset password</a></p><p>If you did not request this, you can ignore this message.</p>`
  }, 'password_reset');
}

export async function sendVerificationCode({ to, code, kind, expiresInMinutes }) {
  const subject = 'Your Ember verification code';
  const label = kind === 'phone' ? 'phone number' : 'email address';
  return send({
    to,
    subject,
    text: `Your Ember verification code is ${code}. It expires in ${expiresInMinutes} minutes. If you did not request this, ignore this message.`,
    html: `<p>Your Ember verification code is <strong>${escapeHtml(code)}</strong>.</p><p>It expires in ${Number(expiresInMinutes)} minutes. If you did not request this, ignore this message.</p>`,
    headers: { 'X-Ember-Verification-Channel': label }
  }, 'verification_code');
}

export async function testSmtpConnection() {
  const mailer = getTransport();
  if (!mailer) return { configured: false, reachable: false };
  try {
    await mailer.verify();
    return { configured: true, reachable: true };
  } catch (error) {
    log.error('SMTP connection check failed', { code: error.code || 'SMTP_ERROR' });
    return { configured: true, reachable: false };
  }
}
