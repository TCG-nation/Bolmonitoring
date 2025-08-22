import { chromium } from 'playwright';
import { cfg } from '../config.js';
import { logger } from '../logger.js';

/**
 * { status: 'IN_STOCK'|'OUT_OF_STOCK'|'UNKNOWN', price: number|null, url: string|null, title: string|null }
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

  // Context met NL-headers/locale en een minder "bot-achtige" UA
  const context = await browser.newContext({
    userAgent: cfg.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    locale: 'nl-NL',
    timezoneId: 'Europe/Amsterdam',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
      'Referer': 'https://www.google.com/'
    }
  });

  // Verberg webdriver-flag een beetje
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(cfg.timeoutMs);

  // helper: accept cookies (ook in iframes)
  async function acceptConsent(p) {
    // directe knop op de pagina
    const selectors = [
      'text=/Akkoord/i',
      'text=/Accepteren/i',
      'text=/Alles accepteren/i',
      'text=/Ik ga akkoord/i'
    ];
    for (const sel of selectors) {
      const btn = await p.$(sel);
      if (btn) {
        try { await btn.click({ timeout: 500 }); } catch {}
      }
    }
    // iframe varianten
    for (const frame of p.frames()) {
      for (const sel of selectors) {
        try {
          const b = await frame.$(sel);
          if (b) { await b.click({ timeout: 500 }); }
        } catch {}
      }
    }
  }

  async function extractInfo(p) {
    // 1) JSON-LD
    const jsonLdRaw = await p.$$eval('script[type="application/ld+json"]', nodes =>
      nodes.map(n => n.textContent).filter(Boolean)
    );
    let availability = null, price = null, title = null;

    for (const raw of jsonLdRaw) {
      try {
        const data = JSON.parse(raw);
        const blocks = Array.isArray(data) ? data : [data];
        for (const b of blocks) {
          if (b['@type'] === 'Product') {
            title = b.name || title;
            const offer = b.offers || b.aggregateOffer || null;
            if (offer) {
              availability = offer.availability || (offer.offers && offer.offers[0]?.availability) || availability;
              const p = offer.price || offer.lowPrice || offer.highPrice || null;
              price = p ? Number(String(p).replace(',', '.')) : price;
            }
          }
        }
      } catch {}
    }

    if (!title) title = await p.title();

    // 2) Fallbacks op DOM-teksten
    const hasBuyBtn = await p.$('text=/in winkelwagen/i');
    const hasOut = await p.$('text=/tijdelijk uitverkocht|niet op voorraad/i');

    let status = 'UNKNOWN';
    if (availability && /InStock$/i.test(availability)) status = 'IN_STOCK';
    else if (hasBuyBtn) status = 'IN_STOCK';
    else if (hasOut) status = 'OUT_OF_STOCK';

    return { status, price, title };
  }

  try {
    // Eerste load (kan op consent/home landen)
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(1000);
    await acceptConsent(page);

    // Als we niet op een product zitten (redirect/consent), probeer nogmaals de echte URL
    if (!page.url().includes('/p/')) {
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      await acceptConsent(page);
    }

    // Probeer een paar bekende product-signalen te wachten, maar blijf tolerant
    try { await page.waitForSelector('script[type="application/ld+json"]', { timeout: 3000 }); } catch {}

    const { status, price, title } = await extractInfo(page);
    logger.info({ url: page.url(), status, price, title }, 'Parsed bol product');

    return { status, price, url, title };
  } catch (e) {
    logger.warn({ err: e, finalUrl: page.url?.() }, 'Bol check failed');
    return { status: 'UNKNOWN', price: null, url, title: null };
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}
