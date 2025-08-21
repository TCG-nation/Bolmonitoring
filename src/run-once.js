import { cfg } from './config.js';
import { logger } from './logger.js';
import { loadWatchlist, loadState, saveState } from './state.js';
import { checkBolProduct } from './parsers/bol.js';
import { notifyDiscord } from './notifier/discord.js';

async function main() {
  const watchlist = loadWatchlist();
  const state = loadState();
  let changed = false;

  for (const item of watchlist) {
    logger.info({ id: item.id }, 'Checking item');

    const res = await checkBolProduct({ url: item.url });
    const prev = state[item.id] || { status: 'UNKNOWN', price: null };
    state[item.id] = { status: res.status, price: res.price, ts: Date.now() };

    const becameInStock = prev.status !== 'IN_STOCK' && res.status === 'IN_STOCK';
    const belowTarget = typeof item.targetPrice === 'number' && typeof res.price === 'number' && res.price <= item.targetPrice;

    if (becameInStock || belowTarget) {
      const title = res.title || item.label || item.id;
      const price = typeof res.price === 'number' ? `${res.price.toFixed(2)}€` : 'n.v.t.';
      const url = res.url || item.url || '';
      const text = `🔔 ${title} is 🟢 OP VOORRAAD\nPrijs: ${price}\nLink: ${url}`;
      await notifyDiscord(text);
    }
    changed = true;
  }

  if (changed) saveState(state);
}

main().catch(e => { logger.error(e); process.exit(1); });
