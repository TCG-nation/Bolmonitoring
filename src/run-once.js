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

    // huidige status in state.json
    const prev = state[item.id] || { status: 'UNKNOWN', price: null, stockHint: null };
    state[item.id] = {
      status: res.status,
      price: res.price,
      stockHint: res.stockHint ?? null,
      ts: Date.now()
    };

    // bepalen of er een melding moet komen
    const becameInStock = prev.status !== 'IN_STOCK' && res.status === 'IN_STOCK';
    const belowTarget =
      typeof item.targetPrice === 'number' &&
      typeof res.price === 'number' &&
      res.price <= item.targetPrice;

    if (becameInStock || belowTarget) {
      const title = res.title || item.label || item.id;
      const priceTxt =
        typeof res.price === 'number' ? `${res.price.toFixed(2)}€` : 'n.v.t.';
      const stockTxt =
        res.stockHint != null ? `\nSchatting voorraad: ${res.stockHint}` : '';
      const url = res.url || item.url || '';
      const text = `🔔 ${title} is 🟢 OP VOORRAAD\nPrijs: ${priceTxt}${stockTxt}\nLink: ${url}`;
      await notifyDiscord(text);
    }

    // log voor debug
    logger.info(
      {
        id: item.id,
        status: res.status,
        price: res.price,
        stockHint: res.stockHint,
        title: res.title
      },
      'Result'
    );

    changed = true;
  }

  if (changed) saveState(state);
}

main().catch(e => {
  logger.error(e);
  process.exit(1);
});
