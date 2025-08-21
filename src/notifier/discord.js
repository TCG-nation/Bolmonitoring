import { request } from 'undici';
import { cfg } from '../config.js';
import { logger } from '../logger.js';

export async function notifyDiscord(content) {
  if (!cfg.discordWebhook) return;
  try {
    await request(cfg.discordWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content })
    });
  } catch (e) {
    logger.warn({ err: e }, 'Discord notify failed');
  }
}
