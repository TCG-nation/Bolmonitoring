import { chromium } from 'playwright';
import { cfg } from '../config.js';
import { logger } from '../logger.js';

/**
 * @returns {Promise<{status: 'IN_STOCK'|'OUT_OF_STOCK'|'UNKNOWN', price: number|null, url: string|null, title: string|null}>}
 */
export async function checkBolProduct({ url }) {
  if (!url) return { status: 'UNKNOWN', price: null, url: null, title: null };

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  // Context met NL headers en userAgent
  const context = await browser.newContext({
    userAgent:
      cfg.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    locale: 'nl-NL',
    timezoneId: 'Europe/Amsterdam',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
      Referer: 'https://www.google.com/'
    }
  });

  // verberg webdriver flag een beetje
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(cfg.timeoutMs);

  async function acceptConsent(p) {
    const selectors = [
      'text=/Akkoord/i',
      'text=/Accepteren/i',
      'text=/Alles accepteren/i',
      'text=/Ik ga akkoord/i'
    ];
    for (const sel of selectors) {
      const btn = await p.$(sel);
      if (btn) {
        try {
          await btn.click({ timeout: 500 });
        } catch {}
      }
    }
    // iframe varianten
    for (const frame of p.frames()) {
      for (const sel of selectors) {
        try {
          const b = await frame.$(sel);
          if (b) {
            await b.click({ timeout: 500 });
          }
        } catc
