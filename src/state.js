import fs from 'node:fs';
const PATH = './watchlist.json';
const STATE = './state.json';

export function loadWatchlist() {
  return JSON.parse(fs.readFileSync(PATH, 'utf8'));
}
export function loadState() {
  if (!fs.existsSync(STATE)) return {};
  return JSON.parse(fs.readFileSync(STATE, 'utf8'));
}
export function saveState(state) {
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
}
