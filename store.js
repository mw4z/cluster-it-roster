// store.js — per-day dashboard edits (shift overrides, in-charge),
// persisted to a JSON file so they survive restarts.
// Note: on hosts with an ephemeral disk (e.g. Render free tier) point DATA_FILE
// at a persistent disk, otherwise the file is reset on each deploy.

const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const KEEP_DAYS = 120;
const EMPTY = () => ({ inCharge: {}, shiftOverrides: {} });

let data = {};
try {
  data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[store] could not read data file:', e.message);
}

let writeTimer = null;
function scheduleWrite() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error('[store] write failed:', e.message);
    }
  }, 300);
}

function prune() {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  for (const key of Object.keys(data)) if (key < cutoff) delete data[key];
}

function get(dateKey) {
  return { ...EMPTY(), ...(data[dateKey] || {}) };
}

// Merges only the fields provided.
function update(dateKey, fields) {
  const current = get(dateKey);
  for (const f of ['inCharge', 'shiftOverrides']) {
    if (fields[f] && typeof fields[f] === 'object') current[f] = fields[f];
  }
  data[dateKey] = current;
  prune();
  scheduleWrite();
  return current;
}

function flush() {
  if (!writeTimer) return;
  clearTimeout(writeTimer);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

process.on('exit', flush);

module.exports = { get, update, flush };
