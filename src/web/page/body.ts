// Dashboard body markup: header, tabs, panels, footer.
// adminOnlyAttr is empty for admins and carries the hidden attribute for readonly users.
//
// All times in Settings are server time (UTC-2, fixed): match-slot selects keep
// canonical game-time values (UTC+2 fixed) but show server-time labels; the
// registration-close selects are hour-only server-time values ('HH:00').
function renderCloseHourOptions(selected: string): string {
  let out = '';
  for (let h = 0; h < 24; h++) {
    const v = String(h).padStart(2, '0') + ':00';
    out += '<option value="' + v + '"' + (v === selected ? ' selected' : '') + '>' + String(h).padStart(2, '0') + '</option>';
  }
  return out;
}

export function renderBody(opts: { isAdmin: boolean; adminOnlyAttr: string }): string {
  const { isAdmin, adminOnlyAttr } = opts;
  return `<header>
  <div>
    <h1 style="margin:0">Trinity Alliance Tracker <span class="muted" style="font-size:.85rem;font-weight:400" data-i18n="app.by">by Zukiren</span></h1>
    ${isAdmin ? '<div style="color:#ef4444;font-size:.85rem;font-weight:700;letter-spacing:.05em" data-i18n="app.admin">ADMIN</div>' : ''}
  </div>
  <div style="display:flex;align-items:center;gap:.6rem;flex-wrap:wrap">
    <span class="muted" id="last-updated"></span>
    <select id="lang-select" aria-label="Language" style="background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.25rem .4rem;font-size:.85rem">
      <option value="en">English</option>
      <option value="fr">Français</option>
      <option value="de">Deutsch</option>
      <option value="ru">Русский</option>
      <option value="it">Italiano</option>
    </select>
  </div>
</header>

<nav class="tabs">
  <button id="tab-active" class="active" data-tab="active" data-i18n="tab.active">Active players</button>
  <button id="tab-queue" data-tab="queue" data-i18n="tab.queue">Train queue</button>
  <button id="tab-pick" data-tab="pick"${adminOnlyAttr} data-i18n="tab.pick">Random train pick</button>
  <button id="tab-board" data-tab="board" data-i18n="tab.board">Leaderboard history</button>
  <button id="tab-upload" data-tab="upload"${adminOnlyAttr} data-i18n="tab.upload">Upload leaderboard</button>
  <button id="tab-events" data-tab="events" data-i18n="tab.events">Events</button>
  <button id="tab-settings" data-tab="settings" data-i18n="tab.settings">Settings</button>
</nav>

<section id="panel-active" class="panel">
  <div class="filters">
    <span class="status" id="active-status" data-i18n="common.loading">Loading…</span>
    <span class="spacer"></span>
    <button id="active-merge" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.3rem .6rem;cursor:pointer"${adminOnlyAttr} data-i18n="active.merge">Merge…</button>
    <button id="active-add" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.3rem .6rem;cursor:pointer"${adminOnlyAttr} data-i18n="active.add">Add player…</button>
    <button id="active-remove" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.3rem .6rem;cursor:pointer"${adminOnlyAttr} data-i18n="active.remove">Remove player…</button>
    <button id="active-rename" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.3rem .6rem;cursor:pointer"${adminOnlyAttr} data-i18n="active.rename">Rename…</button>
    <button id="active-refresh" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.3rem .6rem;cursor:pointer"${adminOnlyAttr} data-i18n="common.refresh">Refresh</button>
  </div>
  <div class="table-wrap">
    <table id="active-table">
      <thead>
        <tr>
          <th data-sort="name" data-i18n="active.col.name">Name</th>
          <th data-sort="lastTrainDate" class="num" data-i18n="active.col.lastTrain">Last train</th>
          <th data-sort="lastVipDate" class="num" data-i18n="active.col.lastVip">Last VIP</th>
          <th data-sort="daysSinceTrain" class="num" data-i18n="active.col.waitingTrain">Waiting train</th>
          <th data-sort="daysSinceVip" class="num" data-i18n="active.col.waitingVip">Waiting VIP</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>
  <div id="active-empty" class="empty hidden" data-i18n="active.empty">No active members.</div>
  <dialog id="active-merge-dialog" style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:1.1rem 1.25rem;min-width:min(90vw,420px);max-width:92vw">
    <form method="dialog" id="active-merge-form" style="display:flex;flex-direction:column;gap:.7rem">
      <h3 style="margin:0;font-size:1rem" data-i18n="active.merge.title">Merge two players</h3>
      <p class="muted" style="margin:0;font-size:.8rem;line-height:1.4" data-i18n="active.merge.help">The duplicate name will be removed; its rewards, aliases and queue slot will be transferred to the target.</p>
      <label style="display:flex;flex-direction:column;gap:.25rem;font-size:.85rem;color:var(--muted)">
        <span data-i18n="active.merge.targetLabel">Keep this name (target)</span>
        <select id="active-merge-target" style="background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.4rem .5rem;font-size:.95rem"></select>
      </label>
      <label style="display:flex;flex-direction:column;gap:.25rem;font-size:.85rem;color:var(--muted)">
        <span data-i18n="active.merge.duplicateLabel">Remove this name (duplicate)</span>
        <select id="active-merge-duplicate" style="background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.4rem .5rem;font-size:.95rem"></select>
      </label>
      <label style="display:flex;align-items:flex-start;gap:.5rem;font-size:.82rem;color:var(--muted);cursor:pointer">
        <input type="checkbox" id="active-merge-poc-duplicate" style="margin-top:.15rem;flex-shrink:0">
        <span data-i18n="active.merge.pocDuplicateLabel">Inherit event registrations from duplicate (account transfer — duplicate\u2019s registrations win on conflict)</span>
      </label>
      <div id="active-merge-error" class="muted" style="color:#ff6b6b;font-size:.8rem;min-height:1em"></div>
      <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:.25rem">
        <button type="button" id="active-merge-cancel" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.4rem .8rem;cursor:pointer" data-i18n="common.cancel">Cancel</button>
        <button type="submit" id="active-merge-confirm" style="background:var(--accent);border:none;color:#0d1117;border-radius:4px;padding:.4rem .9rem;cursor:pointer;font-weight:600" data-i18n="active.merge.submit">Merge</button>
      </div>
    </form>
  </dialog>
  <dialog id="active-remove-dialog" style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:1.1rem 1.25rem;min-width:min(90vw,420px);max-width:92vw">
    <form method="dialog" id="active-remove-form" style="display:flex;flex-direction:column;gap:.7rem">
      <h3 style="margin:0;font-size:1rem" data-i18n="active.remove.title">Remove a player</h3>
      <p class="muted" style="margin:0;font-size:.8rem;line-height:1.4" data-i18n="active.remove.help">The player will be deactivated and removed from the train queue. Their reward history is kept.</p>
      <label style="display:flex;flex-direction:column;gap:.25rem;font-size:.85rem;color:var(--muted)">
        <span data-i18n="active.remove.pickLabel">Player to remove</span>
        <select id="active-remove-select" style="background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.4rem .5rem;font-size:.95rem"></select>
      </label>
      <div id="active-remove-error" class="muted" style="color:#ff6b6b;font-size:.8rem;min-height:1em"></div>
      <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:.25rem">
        <button type="button" id="active-remove-cancel" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.4rem .8rem;cursor:pointer" data-i18n="common.cancel">Cancel</button>
        <button type="submit" id="active-remove-confirm" style="background:#d97070;border:none;color:#0d1117;border-radius:4px;padding:.4rem .9rem;cursor:pointer;font-weight:600" data-i18n="active.remove.submit">Remove</button>
      </div>
    </form>
  </dialog>
  <dialog id="active-rename-dialog" style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:1.1rem 1.25rem;min-width:min(90vw,420px);max-width:92vw">
    <form method="dialog" id="active-rename-form" style="display:flex;flex-direction:column;gap:.7rem">
      <h3 style="margin:0;font-size:1rem" data-i18n="active.rename.title">Rename a player</h3>
      <p class="muted" style="margin:0;font-size:.8rem;line-height:1.4" data-i18n="active.rename.help">The player will be renamed. The old name is saved as an alias so existing reward history still matches.</p>
      <label style="display:flex;flex-direction:column;gap:.25rem;font-size:.85rem;color:var(--muted)">
        <span data-i18n="active.rename.pickLabel">Player to rename</span>
        <select id="active-rename-select" style="background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.4rem .5rem;font-size:.95rem"></select>
      </label>
      <label style="display:flex;flex-direction:column;gap:.25rem;font-size:.85rem;color:var(--muted)">
        <span data-i18n="active.rename.newNameLabel">New name</span>
        <input type="text" id="active-rename-newname" autocomplete="off" style="background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.4rem .5rem;font-size:.95rem">
      </label>
      <div id="active-rename-error" class="muted" style="color:#ff6b6b;font-size:.8rem;min-height:1em"></div>
      <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:.25rem">
        <button type="button" id="active-rename-cancel" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.4rem .8rem;cursor:pointer" data-i18n="common.cancel">Cancel</button>
        <button type="submit" id="active-rename-confirm" style="background:var(--accent);border:none;color:#0d1117;border-radius:4px;padding:.4rem .9rem;cursor:pointer;font-weight:600" data-i18n="active.rename.submit">Rename</button>
      </div>
    </form>
  </dialog>
</section>

<section id="panel-queue" class="panel hidden">
  <div class="filters">
    <span class="status" id="queue-status" data-i18n="common.loading">Loading…</span>
    <span class="spacer"></span>
    <button id="queue-refresh" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.3rem .6rem;cursor:pointer" data-i18n="common.refresh">Refresh</button>
  </div>
  <div id="queue-stale-warning" class="hidden" style="color:#f85149;font-weight:600;font-size:.9rem;margin:.25rem 0 .5rem;padding:.5rem .75rem;background:#3a0d0d;border:1px solid #f85149;border-radius:6px"></div>
  <p class="muted" style="font-size:.8rem;margin:.25rem 0 .75rem" id="queue-intro">
    <span data-i18n="queue.intro.base">Train queue: the player at position 1 is next up. After someone receives a train reward the bot automatically moves them to the end of the queue. </span><span data-i18n="${isAdmin ? 'queue.intro.admin' : 'queue.intro.readonly'}">${isAdmin ? 'Admins can also select players and shift them up/down or send them to the end of the queue — a comment is always required and shown in the log below.' : 'Only admins can reorder the queue.'}</span>
  </p>
  <details id="queue-rules-details" style="margin:.25rem 0 .75rem;border:1px solid var(--border);border-radius:6px;background:var(--panel-2)">
    <summary style="cursor:pointer;padding:.5rem .75rem;color:var(--accent);font-weight:600;font-size:.95rem;list-style:none" data-i18n="queue.rules.title">
      Queue rules
    </summary>
    <div style="padding:.5rem .9rem .75rem;border-top:1px solid var(--border);font-size:.85rem;line-height:1.5">
      <div style="font-weight:600;color:#ff6b6b;margin:.1rem 0 .25rem" data-i18n="queue.rules.penalties">Penalties</div>
      <ul style="margin:.1rem 0 .6rem;padding-left:1.25rem">
        <li data-i18n="queue.rules.r1">−1 place per VS day with less than 7.2M points.</li>
        <li data-i18n="queue.rules.r2">−1 place if the max VS points threshold is breached during an ECO week.</li>
        <li data-i18n="queue.rules.r3">−5 places (main) / −2 places (sub) if registered for Canyon or Desert Storm but absent.</li>
      </ul>
      <div style="font-weight:600;color:#4ade80;margin:.1rem 0 .25rem" data-i18n="queue.rules.bonuses">Bonuses</div>
      <ul style="margin:.1rem 0;padding-left:1.25rem">
        <li data-i18n="queue.rules.r5">+2 places for MVP during SvS week (only if not an ECO week).</li>
        <li data-i18n="queue.rules.r6">Push week placement: +5 for top 3, +2 for top 10, +1 for top 20.</li>
        <li data-i18n="queue.rules.r7">+1 place for top daily score during push week.</li>
        <li data-i18n="queue.rules.r8">+1 place for participation in season activities.</li>
        <li data-i18n="queue.rules.r9">+1 place for ranking in the individual leaderboard of a Meteorite event (once per event).</li>
      </ul>
    </div>
  </details>
  ${isAdmin ? `<div id="queue-bulk-bar" style="display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-bottom:.5rem;padding:.5rem;border:1px solid var(--border);border-radius:6px;background:var(--panel-2)">
    <span class="muted" style="font-size:.85rem"><span id="queue-selected-count">0</span> <span data-i18n="queue.bulk.selected">selected</span></span>
    <label style="font-size:.85rem;color:var(--muted);display:flex;align-items:center;gap:.35rem"><span data-i18n="queue.bulk.spots">spots</span> <input type="number" id="queue-bulk-spots" min="1" max="50" value="1" style="width:4rem;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.25rem .4rem" /></label>
    <button id="queue-bulk-up" disabled style="background:transparent;border:1px solid var(--border);color:var(--text);border-radius:4px;padding:.3rem .7rem;cursor:pointer" data-i18n="queue.bulk.up">▲ Move up</button>
    <button id="queue-bulk-down" disabled style="background:transparent;border:1px solid var(--border);color:var(--text);border-radius:4px;padding:.3rem .7rem;cursor:pointer" data-i18n="queue.bulk.down">▼ Move down</button>
    <button id="queue-bulk-end" disabled style="background:transparent;border:1px solid var(--border);color:var(--text);border-radius:4px;padding:.3rem .7rem;cursor:pointer" data-i18n="queue.bulk.end">⤓ Move to end</button>
    <button id="queue-bulk-clear" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.3rem .6rem;cursor:pointer;font-size:.8rem" data-i18n="queue.bulk.clear">Clear</button>
  </div>` : ''}
  <div class="table-wrap">
    <table id="queue-table">
      <thead>
        <tr>
          ${isAdmin ? '<th style="width:1.5rem"><input type="checkbox" id="queue-select-all" data-i18n-attr="title:queue.bulk.selectAll" title="Select all" /></th>' : ''}
          <th class="num" data-i18n="queue.col.position">#</th>
          <th data-i18n="queue.col.name">Name</th>
          <th class="num" data-i18n="queue.col.lastTrain">Last train</th>
          <th class="num" data-i18n="queue.col.waiting">Waiting</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>
  <div id="queue-empty" class="empty hidden" data-i18n="queue.empty">Queue is empty.</div>

  <details id="queue-log-details" style="margin-top:1.25rem;border:1px solid var(--border);border-radius:6px;background:var(--panel-2)">
    <summary style="cursor:pointer;padding:.5rem .75rem;color:var(--accent);font-weight:600;font-size:.95rem;list-style:none">
      <span data-i18n="queue.log.title">Queue log</span> <span class="muted" id="queue-log-count" style="font-weight:400;font-size:.85rem"></span>
    </summary>
    <div style="height:min(70vh,900px);min-height:340px;overflow-y:auto;border-top:1px solid var(--border);resize:vertical">
      <div class="table-wrap">
        <table id="queue-log-table">
          <thead>
            <tr>
              <th data-i18n="queue.log.col.when">When</th>
              <th data-i18n="queue.log.col.player">Player</th>
              <th data-i18n="queue.log.col.action">Action</th>
              <th class="num" data-i18n="queue.log.col.range">From → To</th>
              <th data-i18n="queue.log.col.comment">Comment</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <div id="queue-log-empty" class="empty hidden" data-i18n="queue.log.empty">No queue activity yet.</div>
    </div>
  </details>
</section>

<section id="panel-pick" class="panel hidden"${adminOnlyAttr}>
  <div class="filters">
    <label><span data-i18n="pick.howMany">How many</span> <input type="number" id="pick-count" min="1" max="50" value="5" /></label>
    <label><span data-i18n="pick.minDays">Min days since train</span> <input type="number" id="pick-days" min="1" max="365" value="30" /></label>
    <button id="pick-load" style="background:transparent;border:1px solid var(--border);color:var(--text);border-radius:4px;padding:.4rem .8rem;cursor:pointer" data-i18n="pick.load">Load eligible</button>
    <button id="pick-roll" style="background:var(--accent);color:#0d1117;border:none;border-radius:4px;padding:.4rem .9rem;cursor:pointer;font-weight:600" disabled data-i18n="pick.pick">Pick</button>
    <button id="pick-copy" class="muted hidden" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.3rem .6rem;cursor:pointer" data-i18n="common.copy">Copy</button>
    <span class="status" id="pick-status" data-i18n="pick.statusInit">Set min days and press “Load eligible”.</span>
  </div>
  <div id="pick-eligible-wrap" class="hidden" style="margin-bottom:.75rem">
    <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.4rem">
      <strong id="pick-eligible-title" style="font-size:.9rem" data-i18n="pick.eligible">Eligible</strong>
      <span class="muted" id="pick-eligible-count" style="font-size:.8rem"></span>
      <span class="spacer" style="flex:1"></span>
      <button id="pick-all" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.2rem .5rem;cursor:pointer;font-size:.8rem" data-i18n="pick.selectAll">Select all</button>
      <button id="pick-none" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.2rem .5rem;cursor:pointer;font-size:.8rem" data-i18n="pick.clear">Clear</button>
    </div>
    <div id="pick-eligible-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.25rem .75rem;max-height:340px;overflow-y:auto;padding:.5rem;border:1px solid var(--border);border-radius:6px;background:var(--panel-2)"></div>
  </div>
  <pre id="pick-output" style="background:var(--panel-2);border:1px solid var(--border);border-radius:6px;padding:.75rem 1rem;margin:0;min-height:2rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.95rem;white-space:pre-wrap;word-break:break-word;user-select:text"></pre>
</section>

<section id="panel-board" class="panel hidden">
  <div class="filters">
    <label><span data-i18n="board.ranking">Ranking</span> <select id="board-select" style="min-width:14rem"></select></label>
    <span class="status" id="board-status" data-i18n="common.loading">Loading…</span>
    <span class="spacer"></span>
    <button id="board-refresh" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.3rem .6rem;cursor:pointer" data-i18n="common.refresh">Refresh</button>
    <button id="board-delete" style="background:transparent;border:1px solid var(--bad);color:var(--bad);border-radius:4px;padding:.3rem .6rem;cursor:pointer" disabled${adminOnlyAttr} data-i18n="common.delete">Delete</button>
  </div>
  <div class="table-wrap">
    <table id="board-table">
      <thead>
        <tr>
          <th data-sort="rank" class="num" data-i18n="board.col.rank">Rank</th>
          <th data-sort="commander" data-i18n="board.col.commander">Commander</th>
          <th data-sort="points" class="num" data-i18n="board.col.points">Points</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>
  <div id="board-empty" class="empty hidden" data-i18n="board.empty">No leaderboard data.</div>
</section>

<section id="panel-upload" class="panel hidden"${adminOnlyAttr}>
  <details style="margin-bottom:.75rem">
    <summary style="cursor:pointer;color:var(--accent);font-weight:600" data-i18n="upload.how.title">How to obtain the JSON (click to expand)</summary>
    <div class="muted" style="font-size:.85rem;line-height:1.5;margin-top:.5rem">
      <p data-i18n="upload.how.p1">Take screenshots of the in-game leaderboard, then send them to a vision-capable LLM (llama.cpp + Qwen3-VL, vLLM, GPT-4o, etc.) with this prompt:</p>
      <div style="position:relative">
        <pre id="upload-prompt" style="background:var(--panel-2);border:1px solid var(--border);border-radius:6px;padding:.6rem 4.5rem .6rem .8rem;white-space:pre-wrap;user-select:text;font-size:.85rem;margin:0">These are screenshots of leaderboard in the Last War online game. Parse them and create a table in JSON format containing this leaderboard, using the fields Ranking, Commander, and Points. Return only the JSON array, without any commentary.</pre>
        <button id="upload-prompt-copy" type="button" style="position:absolute;top:.4rem;right:.4rem;background:var(--panel);border:1px solid var(--border);color:var(--text);border-radius:4px;padding:.2rem .55rem;cursor:pointer;font-size:.75rem" data-i18n="common.copy">Copy</button>
      </div>
      <p data-i18n="upload.how.p2">The expected JSON shape is an array like:</p>
      <pre style="background:var(--panel-2);border:1px solid var(--border);border-radius:6px;padding:.6rem .8rem;white-space:pre-wrap;user-select:text;font-size:.85rem">[
  { "Ranking": 1, "Commander": "SomeName", "Points": 123456 },
  { "Ranking": 2, "Commander": "Another",  "Points": 98765 }
]</pre>
      <p data-i18n-html="upload.how.p3">Paste it below. Lowercase keys (<code>rank</code>, <code>commander</code>, <code>points</code>) are also accepted.</p>
    </div>
  </details>
  <div class="filters" style="flex-direction:column;align-items:stretch;gap:.5rem">
    <div style="display:flex;flex-wrap:wrap;gap:.75rem;align-items:center">
      <label style="flex:1;min-width:14rem"><span data-i18n="upload.nameLabel">Name (title)</span>
        <input type="text" id="upload-title" placeholder="e.g. WW18 Wed S3E7" style="width:100%;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.35rem .5rem" />
      </label>
      <label style="flex:1;min-width:14rem"><span data-i18n="upload.slugLabel">Slug (identifier)</span>
        <input type="text" id="upload-slug" placeholder="e.g. leaderboard-ww18-wed-s3e7-26" style="width:100%;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.35rem .5rem" />
      </label>
    </div>
    <label style="display:flex;flex-direction:column;gap:.25rem">
      <span class="muted" style="font-size:.85rem" data-i18n="upload.jsonLabel">Leaderboard JSON</span>
      <textarea id="upload-json" rows="10" placeholder='[{"Ranking":1,"Commander":"...","Points":0}]' style="width:100%;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:.5rem .75rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.85rem;resize:vertical"></textarea>
    </label>
    <div style="display:flex;gap:.5rem;align-items:center">
      <button id="upload-submit" style="background:var(--accent);color:#0d1117;border:none;border-radius:4px;padding:.45rem 1rem;cursor:pointer;font-weight:600" data-i18n="upload.submit">Upload</button>
      <span class="status" id="upload-status"></span>
    </div>
  </div>

  <div id="upload-missing-wrap" class="hidden" style="margin-top:1rem;border-top:1px solid var(--border);padding-top:.75rem">
    <h3 style="margin:.25rem 0;font-size:1rem" data-i18n="upload.missingHeader">Active members missing from this leaderboard</h3>
    <p class="muted" style="font-size:.85rem;margin:.25rem 0 .75rem" data-i18n-html="upload.missingIntro">Choose what to do with each. Default is Keep (member stays active but is absent this week). If the JSON was incomplete, press <strong>Discard upload</strong> to remove this leaderboard entirely.</p>
    <div id="upload-missing-list" style="display:flex;flex-direction:column;gap:.4rem;max-height:420px;overflow-y:auto;padding:.25rem"></div>
    <div style="display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;margin-top:.75rem">
      <button id="upload-apply" style="background:var(--accent);color:#0d1117;border:none;border-radius:4px;padding:.45rem 1rem;cursor:pointer;font-weight:600" data-i18n="upload.apply">Apply decisions</button>
      <button id="upload-discard" style="background:transparent;border:1px solid var(--bad);color:var(--bad);border-radius:4px;padding:.45rem 1rem;cursor:pointer;font-weight:600" data-i18n="upload.discard">Discard upload</button>
      <span class="status" id="upload-apply-status"></span>
    </div>
  </div>
</section>

<section id="panel-events" class="panel hidden">
  <div class="filters">
    <label style="flex:1 1 100%;min-width:0"><span data-i18n="ev.eventLabel">Event</span>
      <select id="ev-event-select" style="width:100%;min-width:0"></select>
    </label>
    <span class="status" id="ev-event-status" data-i18n="common.loading">Loading…</span>
    <span class="spacer"></span>
    <button id="ev-refresh" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.3rem .6rem;cursor:pointer" data-i18n="common.refresh">Refresh</button>
  </div>

  <div id="ev-event-meta" class="ev-card" style="margin-bottom:.75rem;display:none"></div>

  <div id="ev-reg-form-section" class="ev-card" style="margin-bottom:.75rem">
    <h3 style="margin:.1rem 0 .5rem;font-size:.95rem" data-i18n="ev.reg.title">My registration</h3>
    <p class="muted" style="font-size:.75rem;margin:0 0 .25rem" data-i18n="ev.reg.help">Submitting this form means you are available for this event. The admin decides who plays main vs sub and who sits out.</p>
    <p class="muted" style="font-size:.75rem;margin:0 0 .5rem" data-i18n="ev.reg.noChange">Once submitted, your registration cannot be changed. If you need to update it, contact an admin.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.5rem">
      <label style="display:flex;flex-direction:column;gap:.2rem;font-size:.8rem;color:var(--muted)">
        <span data-i18n="ev.reg.player">Player</span>
        <select id="ev-reg-member" required style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.3rem .4rem"></select>
      </label>
      <label style="display:flex;flex-direction:column;gap:.2rem;font-size:.8rem;color:var(--muted)">
        <span data-i18n="ev.reg.power">T1 squad power (M)</span>
        <input type="number" id="ev-reg-power" min="0.1" step="0.01" placeholder="e.g. 41.5" required style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.3rem .4rem" data-i18n-attr="placeholder:ev.reg.powerPlaceholder" />
      </label>
      <label style="display:flex;flex-direction:column;gap:.2rem;font-size:.8rem;color:var(--muted)">
        <span data-i18n="ev.reg.squadType">Squad type</span>
        <select id="ev-reg-type" style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.3rem .4rem">
          <option value="tanks">tanks</option>
          <option value="air">air</option>
          <option value="missiles">missiles</option>
        </select>
      </label>
      <label id="ev-reg-team-wrap" style="display:flex;flex-direction:column;gap:.2rem;font-size:.8rem;color:var(--muted)">
        <span>Team preference (Canyon)</span>
        <select id="ev-reg-team" style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.3rem .4rem;width:100%">
          <option value="any">any</option>
          <option value="A">A</option>
          <option value="B">B</option>
        </select>
      </label>
      <label id="ev-reg-slot-wrap" style="display:flex;flex-direction:column;gap:.2rem;font-size:.8rem;color:var(--muted)">
        <span data-i18n="ev.reg.timeSlot">Time slot (Desert)</span>
        <select id="ev-reg-slot" required style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.3rem .4rem;width:100%">
          <option value="" disabled selected data-i18n="ev.reg.slotPlaceholder">— select time slot —</option>
          <option value="13">13:00 (team B)</option>
          <option value="22">22:00 (team A)</option>
          <option value="any" data-i18n="ev.reg.slotBoth">both times (13:00 + 22:00)</option>
        </select>
      </label>
    </div>
    <label style="display:flex;flex-direction:column;gap:.2rem;font-size:.8rem;color:var(--muted);margin-top:.5rem">
      <span data-i18n="ev.reg.notes">Notes (optional)</span>
      <input type="text" id="ev-reg-notes" placeholder="anything the admin should know" style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.3rem .4rem" data-i18n-attr="placeholder:ev.reg.notesPlaceholder" />
    </label>
    <div style="display:flex;gap:.5rem;align-items:center;margin-top:.5rem">
      <button id="ev-reg-submit" style="background:var(--accent);color:#0d1117;border:none;border-radius:4px;padding:.35rem .8rem;cursor:pointer;font-weight:600" data-i18n="ev.reg.submit">Submit registration</button>
      <span class="status" id="ev-reg-status-msg"></span>
    </div>
  </div>

  <div style="display:flex;align-items:baseline;gap:.5rem;margin:.75rem 0 .35rem">
    <h3 style="margin:0;font-size:.95rem" data-i18n="ev.regs.title">Registrations</h3>
    <span class="muted" id="ev-reg-count" style="font-size:.8rem"></span>
    ${isAdmin ? '<button id="ev-export-regs" class="muted" style="margin-left:auto;background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.2rem .5rem;cursor:pointer;font-size:.75rem" data-i18n="ev.regs.export">Copy as spreadsheet</button>' : ''}
  </div>
  <details style="font-size:.78rem;color:var(--muted);margin:.25rem 0 .5rem">
    <summary data-i18n="ev.regs.prioHelp.summary" style="cursor:pointer">How is priority calculated?</summary>
    <p style="margin:.35rem 0 0 .75rem" data-i18n-html="ev.regs.prioHelp.body">Priority = 1 &minus; (played / registered).</p>
  </details>

  <div class="table-wrap">
    <table id="ev-reg-table">
      <thead><tr>
        <th data-i18n="ev.regs.col.player">Player</th><th class="num" data-i18n="ev.regs.col.power">Power</th><th data-i18n="ev.regs.col.type">Type</th>
        <th data-i18n="ev.regs.col.teamSlot">Team/Slot</th><th data-i18n="ev.regs.col.prio">Prio</th>${isAdmin ? '<th class="ev-notes-col" data-i18n="ev.regs.col.notes">Notes</th>' : ''}<th></th>
      </tr></thead>
      <tbody></tbody>
    </table>
  </div>
  <div id="ev-reg-empty" class="empty hidden" data-i18n="ev.regs.empty">No registrations yet.</div>

  <div id="ev-roster-section" style="display:none;margin-top:1rem;border-top:1px solid var(--border);padding-top:.75rem">
    <div style="display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
      <h3 style="margin:.1rem 0;font-size:.95rem" data-i18n="ev.roster.title">Roster</h3>
      <span class="muted" id="ev-roster-status" style="font-size:.8rem"></span>
      <span class="spacer" style="flex:1"></span>
      <button id="ev-compact" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.3rem .7rem;cursor:pointer;font-size:.85rem" data-i18n="ev.roster.compact">Compact view</button>
      ${isAdmin ? '<button id="ev-suggest" style="background:transparent;border:1px solid var(--border);color:var(--text);border-radius:4px;padding:.3rem .7rem;cursor:pointer" data-i18n="ev.roster.suggest">Generate suggestion</button>' : ''}
      ${isAdmin ? '<button id="ev-assign-roles" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.3rem .7rem;cursor:pointer;font-size:.85rem" data-i18n="ev.roster.assignRoles">Reassign roles</button>' : ''}
      ${isAdmin ? '<button id="ev-export-teams" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.3rem .7rem;cursor:pointer;font-size:.85rem" data-i18n="ev.roster.exportTeams">Export teams</button>' : ''}
      ${isAdmin ? '<button id="ev-post-discord" class="muted" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:.3rem .7rem;cursor:pointer;font-size:.85rem" data-i18n="ev.roster.postDiscord">Post to Discord</button>' : ''}
      ${isAdmin ? '<button id="ev-save-assignments" disabled style="background:transparent;border:1px solid var(--border);color:var(--text);border-radius:4px;padding:.3rem .7rem;cursor:pointer" data-i18n="ev.roster.save">Save roster</button>' : ''}
      ${isAdmin ? '<button id="ev-record-attendance" style="display:none;background:#2563eb;color:#fff;border:none;border-radius:4px;padding:.3rem .7rem;cursor:pointer;font-weight:600" data-i18n="ev.attendance.btn">Record Attendance</button>' : ''}
    </div>
    ${isAdmin ? `<div id="ev-sub-modal" style="display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.6);align-items:center;justify-content:center">
      <div style="background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:1.25rem 1.5rem;min-width:280px;max-width:400px;width:90%">
        <h4 id="ev-sub-modal-title" style="margin:0 0 .75rem;font-size:.95rem"></h4>
        <label style="font-size:.8rem;color:var(--muted);display:block;margin-bottom:.35rem" data-i18n="ev.roster.substituteSelect">Choose substitute…</label>
        <select id="ev-sub-in-select" style="width:100%;padding:.4rem;border-radius:4px;border:1px solid var(--border);background:var(--panel);color:var(--text);font-size:.875rem;margin-bottom:.9rem"></select>
        <div style="display:flex;gap:.5rem;justify-content:flex-end">
          <button id="ev-sub-cancel" style="background:transparent;border:1px solid var(--border);color:var(--text);border-radius:4px;padding:.3rem .7rem;cursor:pointer" data-i18n="common.cancel">Cancel</button>
          <button id="ev-sub-confirm" style="background:#d97070;color:#0d1117;border:none;border-radius:4px;padding:.3rem .8rem;cursor:pointer;font-weight:600" data-i18n="ev.roster.substituteConfirm">Replace &amp; void</button>
        </div>
        <div id="ev-sub-status" style="font-size:.78rem;margin-top:.5rem;color:var(--muted)"></div>
      </div>
    </div>` : ''}
    <div id="ev-compact-modal" style="display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,.88);overflow-y:auto;padding:.6rem">
      <div style="max-width:460px;margin:0 auto;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:.7rem .8rem">
        <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:.4rem">
          <strong id="ev-compact-title" style="font-size:.9rem"></strong>
          <span style="flex:1"></span>
          <button id="ev-compact-close" style="background:transparent;border:1px solid var(--border);color:var(--text);border-radius:4px;padding:.25rem .7rem;cursor:pointer;font-size:.8rem" data-i18n="ev.roster.compactClose">Close</button>
        </div>
        <div id="ev-compact-teams" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.4rem .8rem"></div>
        <p class="muted" style="font-size:.72rem;margin:.45rem 0 0" data-i18n="ev.roster.compactNote">Mains only.</p>
      </div>
    </div>
    <div id="ev-warnings" class="muted" style="font-size:.8rem;margin:.35rem 0;color:var(--warn)"></div>
    ${isAdmin ? '<p id="ev-roster-admin-note" class="muted" style="font-size:.8rem;line-height:1.5;margin:.25rem 0" data-i18n-html="ev.roster.adminNote"></p>' : ''}
    <p class="muted" style="font-size:.75rem;margin:.25rem 0" data-i18n="ev.roster.help">Change a row\u2019s slot dropdown to move a player between Team A, Team B and Bench (and pick main vs sub).</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.75rem;margin-top:.5rem">
      <div>
        <div style="font-weight:600;font-size:.85rem;margin-bottom:.25rem"><span data-i18n="ev.roster.teamA">Team A</span> <span class="muted" id="ev-team-a-count" style="font-weight:400"></span> <span class="muted" id="ev-team-a-power" style="font-weight:400;font-size:.75rem"></span></div>
        <div id="ev-team-a" class="ev-team-col"></div>
      </div>
      <div>
        <div style="font-weight:600;font-size:.85rem;margin-bottom:.25rem"><span data-i18n="ev.roster.teamB">Team B</span> <span class="muted" id="ev-team-b-count" style="font-weight:400"></span> <span class="muted" id="ev-team-b-power" style="font-weight:400;font-size:.75rem"></span></div>
        <div id="ev-team-b" class="ev-team-col"></div>
      </div>
      <div>
        <div style="font-weight:600;font-size:.85rem;margin-bottom:.25rem"><span data-i18n="ev.roster.bench">Bench / not picked</span> <span class="muted" id="ev-bench-count" style="font-weight:400"></span></div>
        <div id="ev-bench" class="ev-team-col"></div>
      </div>
    </div>
  </div>

</section>

<section id="panel-settings" class="panel hidden">
  <div class="ev-card" style="margin-bottom:.75rem;display:flex;flex-direction:column;gap:.5rem">
    <span style="font-size:.85rem;color:var(--muted)" data-i18n="settings.timezone">Display timezone</span>
    <select id="settings-tz" style="background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.35rem .5rem;font-size:.9rem;max-width:320px">
      <option value="UTC">UTC</option>
      <option value="Atlantic/South_Georgia">Server time (UTC\u22122)</option>
      <option value="Europe/Paris">CET / CEST &mdash; Paris, Warsaw, Berlin</option>
      <option value="Europe/London">GMT / BST &mdash; London</option>
      <option value="Europe/Moscow">MSK &mdash; Moscow (UTC+3)</option>
      <option value="Asia/Dubai">GST &mdash; Gulf (UTC+4)</option>
      <option value="Asia/Singapore">SGT &mdash; Singapore (UTC+8)</option>
      <option value="Asia/Tokyo">JST &mdash; Tokyo (UTC+9)</option>
      <option value="Australia/Sydney">AEST &mdash; Sydney</option>
      <option value="America/New_York">ET &mdash; New York</option>
      <option value="America/Los_Angeles">PT &mdash; Los Angeles</option>
    </select>
    <p class="muted" style="margin:0;font-size:.78rem" data-i18n="settings.tz.note">Saved in your browser. Affects how event times are displayed.</p>
  </div>

  <h2 style="margin:0 0 .75rem;font-size:1rem"${adminOnlyAttr} data-i18n="settings.canyon.title">Canyon Storm</h2>
  <div class="ev-card" style="margin-bottom:.75rem;display:flex;flex-direction:column;gap:.65rem"${adminOnlyAttr}>
    <label style="display:flex;align-items:center;gap:.6rem;cursor:pointer;font-size:.95rem">
      <input type="checkbox" id="settings-canyon-auto-open" style="width:1.1rem;height:1.1rem;flex-shrink:0">
      <span data-i18n="settings.autoOpen">Auto-open registration</span>
    </label>
    <p class="muted" style="margin:0;font-size:.8rem;line-height:1.4" data-i18n="settings.autoOpen.help">When enabled, Canyon Storm registration opens automatically every Friday at 00:00 UTC.</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem">
      <div style="display:flex;flex-direction:column;gap:.3rem">
        <span style="font-size:.8rem;color:var(--muted)" data-i18n="settings.teamA">Team A</span>
        <div style="display:flex;gap:.4rem">
          <select id="settings-canyon-a-time" style="flex:1;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.3rem .4rem;font-size:.9rem">
            <option value="16:00">12:00</option>
            <option value="03:00">23:00</option>
          </select>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:.3rem">
        <span style="font-size:.8rem;color:var(--muted)" data-i18n="settings.teamB">Team B</span>
        <div style="display:flex;gap:.4rem">
          <select id="settings-canyon-b-time" style="flex:1;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.3rem .4rem;font-size:.9rem">
            <option value="16:00">12:00</option>
            <option value="03:00">23:00</option>
          </select>
        </div>
      </div>
    </div>
    <p class="muted" style="margin:0;font-size:.78rem" data-i18n="settings.timeNote">All times are in server time (UTC-2).</p>
    <div style="display:flex;flex-direction:column;gap:.3rem;border-top:1px solid var(--border);padding-top:.65rem">
      <span style="font-size:.8rem;color:var(--muted)" data-i18n="settings.regCloseCanyon">Registration closes — Monday (server time)</span>
      <select id="settings-canyon-close-time" style="max-width:10rem;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.3rem .4rem;font-size:.9rem">${renderCloseHourOptions('12:00')}</select>
      <p class="muted" style="margin:0;font-size:.78rem" data-i18n="settings.regCloseHelp">Hour 0–23 in server time (UTC-2); the day is also counted in server time. Applies to newly created events only; already open events keep their deadline.</p>
    </div>
    <div style="display:flex;align-items:center;gap:.75rem">
      <button id="settings-canyon-save" style="background:var(--accent);border:none;color:#0d1117;border-radius:4px;padding:.4rem .9rem;cursor:pointer;font-weight:600" data-i18n="settings.save.canyon">Save Canyon settings</button>
      <span id="settings-canyon-status" class="muted" style="font-size:.85rem"></span>
    </div>
    <div style="display:flex;flex-direction:column;gap:.35rem;border-top:1px solid var(--border);padding-top:.65rem">
      <div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
        <button id="settings-canyon-open-now" style="background:var(--panel-2);border:1px solid var(--border);color:var(--text);border-radius:4px;padding:.4rem .9rem;cursor:pointer;font-weight:600" data-i18n="settings.openCanyonNow">Open Canyon registration now</button>
        <span id="settings-canyon-open-status" class="muted" style="font-size:.85rem"></span>
      </div>
      <p class="muted" style="margin:0;font-size:.8rem;line-height:1.4" data-i18n="settings.openCanyonNow.help">If auto-open was enabled too late (after Friday 00:00 UTC), use this to create the upcoming Canyon registration manually.</p>
    </div>
  </div>

  <h2 style="margin:.25rem 0 .75rem;font-size:1rem"${adminOnlyAttr} data-i18n="settings.desert.title">Desert Storm</h2>
  <div class="ev-card" style="display:flex;flex-direction:column;gap:.65rem"${adminOnlyAttr}>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem">
      <div style="display:flex;flex-direction:column;gap:.3rem">
        <span style="font-size:.8rem;color:var(--muted)" data-i18n="settings.teamA">Team A</span>
        <div style="display:flex;gap:.4rem">
          <select id="settings-desert-a-time" style="flex:1;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.3rem .4rem;font-size:.9rem">
            <option value="22:00">18:00</option>
            <option value="13:00">09:00</option>
            <option value="03:00">23:00</option>
          </select>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:.3rem">
        <span style="font-size:.8rem;color:var(--muted)" data-i18n="settings.teamB">Team B</span>
        <div style="display:flex;gap:.4rem">
          <select id="settings-desert-b-time" style="flex:1;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.3rem .4rem;font-size:.9rem">
            <option value="22:00">18:00</option>
            <option value="13:00">09:00</option>
            <option value="03:00">23:00</option>
          </select>
        </div>
      </div>
    </div>
    <p class="muted" style="margin:0;font-size:.78rem" data-i18n="settings.timeNote">All times are in server time (UTC-2).</p>
    <div style="display:flex;flex-direction:column;gap:.3rem;border-top:1px solid var(--border);padding-top:.65rem">
      <span style="font-size:.8rem;color:var(--muted)" data-i18n="settings.regCloseDesert">Registration closes — Wednesday (server time)</span>
      <select id="settings-desert-close-time" style="max-width:10rem;background:var(--panel-2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:.3rem .4rem;font-size:.9rem">${renderCloseHourOptions('12:00')}</select>
      <p class="muted" style="margin:0;font-size:.78rem" data-i18n="settings.regCloseHelp">Hour 0–23 in server time (UTC-2); the day is also counted in server time. Applies to newly created events only; already open events keep their deadline.</p>
    </div>
    <div style="display:flex;align-items:center;gap:.75rem">
      <button id="settings-desert-save" style="background:var(--accent);border:none;color:#0d1117;border-radius:4px;padding:.4rem .9rem;cursor:pointer;font-weight:600" data-i18n="settings.save.desert">Save Desert settings</button>
      <span id="settings-desert-status" class="muted" style="font-size:.85rem"></span>
    </div>
  </div>
</section>

<footer data-i18n="footer.text">Reference date follows the most recent reward in the database.</footer>`;
}
