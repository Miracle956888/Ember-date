import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('sms');

export async function sendVerificationCode({ to, code, expiresInMinutes }) {
  if (!env.TWILIO.configured) {
    log.warn('SMS delivery is not configured', { category: 'verification_code' });
    return { sent: false, reason: 'not_configured' };
  }

  const account = encodeURIComponent(env.TWILIO.accountSid);
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`;
  const body = new URLSearchParams({
    To: to,
    From: env.TWILIO.fromNumber,
    Body: `Your Ember verification code is ${code}. It expires in ${expiresInMinutes} minutes.`
  });
  const authorization = Buffer.from(`${env.TWILIO.accountSid}:${env.TWILIO.authToken}`).toString('base64');

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authorization}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body,
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      // Never log provider response bodies: some providers echo destination or
      // message data, and these contain personal information and auth codes.
      log.error('SMS provider rejected delivery', { status: response.status });
      return { sent: false, reason: 'provider_error' };
    }
    return { sent: true };
  } catch (error) {
    log.error('SMS delivery failed', { code: error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR' });
    return { sent: false, reason: 'provider_error' };
  }
}
