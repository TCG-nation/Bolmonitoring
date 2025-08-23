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
      'Referer': 'https://www.google.com/',
      'sec-ch-ua': '"Chromium";v="124", "Not-A.Brand";v="24"',
      'sec-ch-ua-platform': '"Windows"',
      'sec-ch-ua-mobile': '?0'
    }
  });

  // verberg webdriver flag iets
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(Math.max(cfg.timeoutMs, 30000));

  async function acceptEverything(p){
    const ids = ['#onetrust-accept-btn-handler','#onetrust-accept-btn-handler button'];
    for (const sel of ids){
      try { const b = await p.$(sel); if (b) { await b.click({timeout: 800}); } } catch {}
    }
    const texts = ['Alles accepteren','Akkoord','Accepteren','Ik ga akkoord'];
    for (const t of texts){
      try { await p.getByText(new RegExp(t,'i')).click({timeout: 800}); } catch {}
    }
    for (const f of p.frames()){
      for (const sel of ids){
        try { const b = await f.$(sel); if (b) { await b.click({timeout:800}); } } catch {}
      }
      for (const t of texts){
        try { await f.getByText(new RegExp(t,'i')).click({timeout:800}); } catch {}
      }
    }
  }

 async function extract(p){
  let availability = null, price = null, title = null, stockHint = null;

  // 1) JSON-LD
  const jsonLd = await p.$$eval('script[type="application/ld+json"]', ns => ns.map(n=>n.textContent).filter(Boolean));
  for (const raw of jsonLd){
    try{
      const data = JSON.parse(raw), arr = Array.isArray(data)?data:[data];
      for (const b of arr){
        if (b['@type'] === 'Product'){
          title = b.name || title;
          const offer = b.offers || b.aggregateOffer || null;
          if (offer){
            availability = availability || offer.availability || (offer.offers && offer.offers[0]?.availability) || null;
            const pval = offer.price ?? offer.lowPrice ?? offer.highPrice;
            if (pval != null){
              const num = Number(String(pval).replace(',','.'));
              if (!Number.isNaN(num)) price = price ?? num;
            }
          }
        }
      }
    } catch {}
  }

  // 2) Next/React JSON (grote scriptblokken incl. __NEXT_DATA__)
  async function readJson(sel){ try{ const t = await p.$eval(sel, el => el.textContent); return t?JSON.parse(t):null; } catch { return null; } }
  let nextData = await readJson('#__NEXT_DATA__');
  if (!nextData){
    const big = await p.$$eval('script:not([type]),script[type="application/json"]', ns =>
      ns.map(n=>n.textContent||'').filter(t=>t.trim().startsWith('{') && t.length>2000).sort((a,b)=>b.length-a.length).slice(0,2)
    );
    for (const s of big){ try { const j = JSON.parse(s); if (j) { nextData = j; break; } } catch {} }
  }
  function deepFind(obj){
    const out={}; const st=[obj];
    while(st.length){
      const cur=st.pop();
      if (cur && typeof cur==='object'){
        for (const [k,v] of Object.entries(cur)){
          const lk=k.toLowerCase();
          if (['availability','instock','in_stock','available','availabilitystate','stockstate'].some(s=>lk.includes(s))){
            out.avail = out.avail ?? (typeof v==='string'?v:(v?.toString?.()??null));
          }
          if (['price','sellingprice','amount','value','currentprice'].some(s=>lk.includes(s))){
            const num=Number(String(v).replace(',','.')); if(!Number.isNaN(num)) out.price = out.price ?? num;
          }
          if (['title','name','productname'].some(s=>lk.includes(s))){
            if(!out.title && typeof v==='string') out.title = v;
          }
          if (['stock','remaining','quantityavailable','inventory','qty','quantity'].some(s=>lk.includes(s))){
            const n = Number(String(v).replace(/[^\d]/g,'')); if (!Number.isNaN(n) && !out.stockHint) out.stockHint = n;
          }
          if (v && typeof v==='object') st.push(v);
        }
      }
    }
    return out;
  }
  if (nextData){
    const f = deepFind(nextData);
    availability = availability || f.avail || null;
    price = price ?? f.price ?? null;
    title = title || f.title || null;
    stockHint = stockHint ?? f.stockHint ?? null;
  }

  // 3) DOM fallback: prijs + “Nog maar X op voorraad”
  if (price == null) {
    try {
      // algemene prijs selectors (bol wisselt dit soms)
      const priceTxt = await p.$eval('[data-test="price"] , [data-test="buy-block"] [class*="price"] , [data-testid*="price"]', el => el.textContent);
      const m = priceTxt && priceTxt.match(/(\d+[.,]\d{2})/);
      if (m) price = Number(m[1].replace(',','.'));
    } catch {}
  }
  try {
    const bodyTxt = await p.evaluate(() => document.body.innerText);
    const m = bodyTxt.match(/Nog maar\s+(\d+)\s+op voorraad/i) || bodyTxt.match(/Slechts\s+(\d+)\s+op voorraad/i);
    if (m) stockHint = Number(m[1]);
  } catch {}

  if (!title) title = await p.title();

  // 4) Status bepalen
  const hasBuy = await p.$('text=/in winkelwagen/i');
  const hasOut = await p.$('text=/tijdelijk uitverkocht|niet op voorraad/i');

  let status='UNKNOWN';
  if (availability && /InStock$/i.test(availability)) status='IN_STOCK';
  else if (typeof availability==='string' && /outofstock|niet/i.test(availability)) status='OUT_OF_STOCK';
  else if (hasBuy) status='IN_STOCK';
  else if (hasOut) status='OUT_OF_STOCK';

  return { status, price, title, stockHint };
  }

  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await acceptEverything(page);

    let tries = 0;
    while (!page.url().includes('/p/') && tries < 2){
      tries++;
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(800);
      await acceptEverything(page);
    }

    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(400);
    await page.mouse.wheel(0, 800);

    // debug assets (indien artifact stap aanwezig)
    try {
      const fs = await import('node:fs');
      fs.mkdirSync('artifacts', { recursive: true });
      const safeId = (url.match(/\/([0-9]{10,})\/?/)?.[1] || Date.now()).toString();
      await page.screenshot({ path: `artifacts/${safeId}.png`, fullPage: true }).catch(()=>{});
      const html = await page.content();
      fs.writeFileSync(`artifacts/${safeId}.html`, html);
    } catch {}

  const out = await extract(page);
logger.info({ visited: page.url(), ...out }, 'Parsed bol product');
return { status: out.status, price: out.price, url, title: out.title, stockHint: out.stockHint ?? null };


    return { status: out.status, price: out.price, url, title: out.title };
  } catch (e) {
    logger.warn({ err: e?.message, finalUrl: page.url?.() }, 'Bol check failed');
    return { status: 'UNKNOWN', price: null, url, title: null };
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}
