import { chromium } from 'playwright';
import { cfg } from '../config.js';
import { logger } from '../logger.js';

/**
 * Result: { status: 'IN_STOCK'|'OUT_OF_STOCK'|'UNKNOWN', price: number|null, url: string|null, title: string|null }
 */
export async function checkBolProduct({ url }) {
  if (!url) return { status: 'UNKNOWN', price: null, url: null, title: null };
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ userAgent: cfg.userAgent, viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(cfg.timeoutMs);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Probeer JSON-LD eerst
    const jsonLdRaw = await page.$$eval('script[type="application/ld+json"]', nodes => nodes.map(n => n.textContent).filter(Boolean));
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

    if (!title) title = await page.title();

    const hasBuyBtn = await page.$('text=/in winkelwagen/i');
    const hasOutOfStock = await page.$('text=/tijdelijk uitverkocht|niet op voorraad/i');

    let status = 'UNKNOWN';
    if (availability && /InStock$/i.test(availability)) status = 'IN_STOCK';
    else if (hasBuyBtn) status = 'IN_STOCK';
    else if (hasOutOfStock) status = 'OUT_OF_STOCK';

    return { status, price, url, title };
  } catch (e) {
    logger.warn({ err: e, url }, 'Bol check failed');
    return { status: 'UNKNOWN', price: null, url, title: null };
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}
