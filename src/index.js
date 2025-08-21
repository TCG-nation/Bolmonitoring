import { setTimeout as sleep } from 'node:timers/promises';
import { cfg } from './config.js';
import { logger } from './logger.js';
import { loadWatchlist, loadState, saveState } from './state.js';
import { checkBolProduct } from './parsers/bol.js';
import { withJitter } from './scheduler.js';
import { notifyDiscord } from './notifier/discord.js';

const state = loadState();

async function notifyAll(item, result) {
  const title = result.title || item.label || item.id;
  const price = typeof result.price === 'number' ? `${result.price.toFixed(2)}€` : 'n.v.t.';
  const url = result.url || item.url || '';
  const text = `🔔 ${title} is ${result.status === 'IN_STOCK' ? '🟢 OP VOORRAAD' : result.status}\nPrijs: ${price}\nLink: ${url}`;
  await notifyDiscord(text);
}

async function processItem(item) {
  const interval = Math.max(Number(item.intervalMinutes || cfg.intervalMinutes), 5);
  while (true) {
    logger.info({ id: item.id }, 'Checking item');
    const result = await checkBolProduct({ url: item.url });

    const prev = state[item.id] || { status: 'UNKNOWN', price: null };
    state[item.id] = { status: result.status, price: result.price, ts: Date.now() };

    const changedToInStock = prev.status !== 'IN_STOCK' && result.status === 'IN_STOCK';
    const priceDrop = typeof result.price === 'number' && typeof prev.price === 'number' && result.price < prev.price;
    const belowTarget = typeof item.targetPrice === 'number' && typeof result.price === 'number' && result.price <= item.targetPrice;

    if (changedToInStock || belowTarget || priceDrop) {
      await notifyAll(item, result);
      saveState(state);
    } else {
      saveState(state);
    }
    const waitMs = withJitter(interval * 60_000, cfg.jitterSeconds);
    await sleep(waitMs);
  }
}

async function main() {
  const watchlist = loadWatchlist();
  if (!Array.isArray(watchlist) || watchlist.length === 0) {
    logger.error('watchlist.json is leeg');
    process.exit(1);
  }
  logger.info({ items: watchlist.length }, 'Starting monitor');
  for (const item of watchlist) processItem(item);
}
main().catch(err => { logger.error({ err }, 'Fatal error'); process.exit(1); });
