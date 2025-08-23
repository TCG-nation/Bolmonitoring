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

  const context = await browser.newContext({
    userAgent:
      cfg.userAgent ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
    locale: 'nl-NL',
    timezoneId: 'Europe/Amsterdam',
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
      'Referer': 'https://www.google.com/'
    }
  });

  // verberg webdriver flag iets
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(cfg.timeoutMs);

  async function acceptConsent(p) {
    // 1) OneTrust (meest gebruikt)
    const candidates = [
      '#onetrust-accept-btn-handler',
      'button#onetrust-accept-btn-handler',
      'button[aria-label*="Alles accepteren"]',
      'text=/Alles accepteren/i',
      'text=/Akkoord/i',
      'text=/Accepteren/i',
      'text=/Ik ga akkoord/i'
    ];

    // direct op page
    for (const sel of candidates) {
      try {
        const b = await p.$(sel);
        if (b) { await b.click({ timeout: 800 }); }
      } catch {}
    }
    // ook in iframes
    for (const f of p.frames()) {
      for (const sel of candidates) {
        try {
          const b = await f.$(sel);
          if (b) { await b.click({ timeout: 800 }); }
        } catch {}
      }
    }

    // 2) Land/taal keuze modals (best‑effort)
    const closeCandidates = [
      'button[aria-label*="sluiten"]',
      'button[aria-label*="close"]',
      '[data-test="modal-close"]',
      'button[title*="Sluiten"]'
    ];
    for (const sel of closeCandidates) {
      try { const b = await p.$(sel); if (b) await b.click({ timeout: 500 }); } catch {}
      for (const f of p.frames()) {
        try { const b = await f.$(sel); if (b) await b.click({ timeout: 500 }); } catch {}
      }
    }
  }

  async function extractInfo(p) {
    let availability = null, price = null, title = null;

    // 1) JSON-LD
    const jsonLdRaw = await p.$$eval('script[type="application/ld+json"]', ns =>
      ns.map(n => n.textContent).filter(Boolean)
    );
    for (const raw of jsonLdRaw) {
      try {
        const data = JSON.parse(raw);
        const blocks = Array.isArray(data) ? data : [data];
        for (const b of blocks) {
          if (b['@type'] === 'Product') {
            title = b.name || title;
            const offer = b.offers || b.aggregateOffer || null;
            if (offer) {
              availability = availability ||
                offer.availability ||
                (offer.offers && offer.offers[0]?.availability) ||
                null;
              const pVal = offer.price ?? offer.lowPrice ?? offer.highPrice ?? null;
              if (pVal != null) {
                const num = Number(String(pVal).replace(',', '.'));
                if (!Number.isNaN(num)) price = price ?? num;
              }
            }
          }
        }
      } catch {}
    }

    // 2) window.__NEXT_DATA__ of andere JSON-blokken
    async function readJson(selector) {
      try {
        const txt = await p.$eval(selector, el => el.textContent);
        return txt ? JSON.parse(txt) : null;
      } catch { return null; }
    }
    let nextData = await readJson('#__NEXT_DATA__');

    if (!nextData) {
      // kies grootste JSON-achtige <script>-inhoud (heuristiek)
      const bigScripts = await p.$$eval('script:not([type]),script[type="application/json"]', ns =>
        ns.map(n => n.textContent || '')
          .filter(t => t.trim().startsWith('{') && t.length > 1500)
          .sort((a,b)=>b.length-a.length)
          .slice(0,3)
      );
      for (const s of bigScripts) {
        try { const j = JSON.parse(s); if (j) { nextData = j; break; } } catch {}
      }
    }

    function deepFind(obj) {
      const out = {};
      const stack = [obj];
      while (stack.length) {
        const cur = stack.pop();
        if (cur && typeof cur === 'object') {
          for (const [k, v] of Object.entries(cur)) {
            const lk = k.toLowerCase();
            if (['availability','instock','in_stock','available','availabilitystate','stockstate'].some(s => lk.includes(s))) {
              out.avail = out.avail ?? (typeof v === 'string' ? v : (v?.toString?.() ?? null));
            }
            if (['price','sellingprice','amount','value','currentprice'].some(s => lk.includes(s))) {
              const num = Number(String(v).replace(',', '.'));
              if (!Number.isNaN(num)) out.price = out.price ?? num;
            }
            if (['title','name','productname'].some(s => lk.includes(s))) {
              if (!out.title && typeof v === 'string') out.title = v;
            }
            if (v && typeof v === 'object') stack.push(v);
          }
        }
      }
      return out;
    }

    if (nextData) {
      const f = deepFind(nextData);
      availability = availability || f.avail || null;
      price = price ?? f.price ?? null;
      title = title || f.title || null;
    }

    if (!title) title = await p.title();

    // 3) DOM fallback (knoppen/teksten)
    const hasBuyBtn = await p.$('text=/in winkelwagen/i');
    const hasOut = await p.$('text=/tijdelijk uitverkocht|niet op voorraad/i');

    let status = 'UNKNOWN';
    if (availability && /InStock$/i.test(availability)) status = 'IN_STOCK';
    else if (typeof availability === 'string' && /outofstock|niet/i.test(availability)) status = 'OUT_OF_STOCK';
    else if (hasBuyBtn) status = 'IN_STOCK';
    else if (hasOut) status = 'OUT_OF_STOCK';

    return { status, price, title };
  }

  try {
    // 1e poging
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await acceptConsent(page);

    // Als we niet op een product zitten, probeer 2 extra pogingen
    let attempts = 0;
    while (!page.url().includes('/p/') && attempts < 2) {
      attempts++;
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(800);
      await acceptConsent(page);
    }

    // Debug assets (als je artifacts-step hebt in je workflow)
    try {
      const fs = await import('node:fs');
      fs.mkdirSync('artifacts', { recursive: true });
      const safeId = (url.match(/\/([0-9]{10,})\/?/)?.[1] || Date.now()).toString();
      await page.screenshot({ path: `artifacts/${safeId}.png`, fullPage: true }).catch(()=>{});
      const html = await page.content();
      fs.writeFileSync(`artifacts/${safeId}.html`, html);
    } catch {}

    const { status, price, title } = await extractInfo(page);
    logger.info({ visited: page.url(), status, price, title }, 'Parsed bol product');

    return { status, price, url, title };
  } catch (e) {
    logger.warn({ err: e?.message, finalUrl: page.url?.() }, 'Bol check failed');
    return { status: 'UNKNOWN', price: null, url, title: null };
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}
