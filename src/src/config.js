export const cfg = {
  intervalMinutes: Number(process.env.CHECK_INTERVAL_MINUTES || 30),
  jitterSeconds: Number(process.env.CHECK_JITTER_SECONDS || 45),
  timeoutMs: Number(process.env.TIMEOUT_MS || 20000),
  userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  discordWebhook: process.env.DISCORD_WEBHOOK_URL || ''
};
