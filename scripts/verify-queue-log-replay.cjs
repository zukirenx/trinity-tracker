// Strict replay verifier for train_queue_log.
//
// Fetches the entire log from the remote D1 database, replays every entry
// chronologically onto an empty queue with NO force-apply (every entry's
// from_pos must exactly match the actual position of its member at that
// timestamp), and asserts the final state equals the current live queue.
//
// Run via: node scripts/verify-queue-log-replay.cjs [--config wrangler.local.toml]
// Wired into `npm run deploy` so that a non-replayable log blocks deploys.
//
// Exits non-zero on any inconsistency.

const { execSync } = require('node:child_process');

// Optional `--config <path>` passthrough for setups where the real D1 id
// lives in a gitignored local config (see `npm run deploy:local`).
const configFlag = (() => {
  const i = process.argv.indexOf('--config');
  return i >= 0 && process.argv[i + 1] ? ' --config ' + process.argv[i + 1] : '';
})();

function runD1(sql) {
  const out = execSync(
    'npx wrangler d1 execute lw-rewards --remote --json -y' + configFlag + ' --command ' + JSON.stringify(sql),
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

const rows = runD1(
  'SELECT id, ts, member_id, member_name, action, from_pos, to_pos '
  + 'FROM train_queue_log ORDER BY ts, id'
);
console.log(`Replaying ${rows.length} log entries...`);

const order = [];
function failAt(r, msg) {
  console.error(`\u2717 Replay failed at log id ${r.id} (${r.ts}, ${r.action} ${r.member_name}): ${msg}`);
  process.exit(1);
}

for (const r of rows) {
  switch (r.action) {
    case 'add': {
      const toPos = r.to_pos == null ? order.length + 1 : r.to_pos;
      if (toPos < 1 || toPos > order.length + 1) failAt(r, `to_pos ${toPos} out of range`);
      order.splice(toPos - 1, 0, r.member_id);
      break;
    }
    case 'remove':
    case 'merge-remove': {
      if (order[r.from_pos - 1] !== r.member_id) {
        failAt(r, `expected member ${r.member_id} at pos ${r.from_pos}, got ${order[r.from_pos - 1]}`);
      }
      order.splice(r.from_pos - 1, 1);
      break;
    }
    case 'auto-train':
    case 'manual-move':
    case 'merge-move': {
      if (order[r.from_pos - 1] !== r.member_id) {
        failAt(r, `expected member ${r.member_id} at pos ${r.from_pos}, got ${order[r.from_pos - 1]}`);
      }
      order.splice(r.from_pos - 1, 1);
      order.splice(r.to_pos - 1, 0, r.member_id);
      break;
    }
    case 'rename': {
      // Cosmetic journal entry; queue positions are unchanged.
      break;
    }
    default:
      failAt(r, `unknown action: ${r.action}`);
  }
}
console.log(`Replayed queue size: ${order.length}`);

const live = runD1('SELECT member_id, position FROM train_queue ORDER BY position');
const liveOrder = live.map(r => r.member_id);

let mismatches = 0;
const maxLen = Math.max(order.length, liveOrder.length);
for (let i = 0; i < maxLen; i++) {
  if (order[i] !== liveOrder[i]) {
    console.error(`  pos ${i + 1}: replay=${order[i]} live=${liveOrder[i]}`);
    mismatches++;
  }
}

if (mismatches === 0) {
  console.log('\u2713 Replay matches live queue exactly. train_queue_log is replay-consistent.');
  process.exit(0);
} else {
  console.error(`\u2717 ${mismatches} mismatches between replayed state and live queue.`);
  process.exit(1);
}
