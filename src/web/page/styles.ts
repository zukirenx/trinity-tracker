// Dashboard stylesheet, inlined into <style> by renderPage (see ../page.ts).
export const PAGE_STYLES: string = `  :root {
    color-scheme: dark;
    --bg: #0d1117;
    --panel: #161b22;
    --panel-2: #1f2630;
    --border: #30363d;
    --text: #e6edf3;
    --muted: #8b949e;
    --accent: #58a6ff;
    --warn: #d29922;
    --bad: #f85149;
    --good: #3fb950;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; -webkit-text-size-adjust: 100%; overflow-x: hidden; }
  body { padding: 1.25rem; max-width: 1100px; margin: 0 auto; }
  header { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; }
  h1 { font-size: 1.4rem; margin: 0; }
  .muted { color: var(--muted); font-size: .85rem; }
  nav.tabs { display: flex; gap: .25rem; border-bottom: 1px solid var(--border); margin-bottom: 1rem; flex-wrap: wrap; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  nav.tabs button { background: transparent; color: var(--muted); border: none; border-bottom: 2px solid transparent; padding: .6rem .9rem; font-size: .95rem; cursor: pointer; white-space: nowrap; }
  nav.tabs button.active { color: var(--text); border-bottom-color: var(--accent); }
  nav.tabs button:hover { color: var(--text); }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; }
  .filters { display: flex; flex-wrap: wrap; gap: .75rem; align-items: center; margin-bottom: .75rem; }
  .filters label { font-size: .85rem; color: var(--muted); display: flex; align-items: center; gap: .35rem; }
  .filters input, .filters select { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: .35rem .5rem; font-size: .9rem; }
  .filters input[type=number] { width: 5rem; }
  .filters .spacer { flex: 1; }
  .status { color: var(--muted); font-size: .85rem; }
  .table-wrap { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { padding: .45rem .6rem; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; cursor: pointer; user-select: none; white-space: nowrap; }
  th .arrow { color: var(--accent); margin-left: .25rem; }
  tbody tr:hover { background: var(--panel-2); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.name { font-weight: 500; word-break: break-word; }
  .pill { display: inline-block; padding: .05rem .45rem; border-radius: 999px; font-size: .75rem; background: var(--panel-2); color: var(--muted); white-space: nowrap; }
  .pill.warn { background: #3a2a08; color: var(--warn); }
  .pill.bad { background: #3a0d0d; color: var(--bad); }
  .pill.good { background: #0d2a16; color: var(--good); }
  /* Inline reference to a dashboard button inside help text. */
  .btn-ref { display: inline-block; padding: .05rem .45rem; border: 1px solid var(--border); border-radius: 4px; font-size: .78rem; background: var(--panel); color: var(--text); white-space: nowrap; }
  .empty { padding: 2rem; text-align: center; color: var(--muted); }
  .hidden { display: none; }
  /* The hidden attribute must win over inline display styles (e.g. the
     admin-only settings cards use inline display:flex). Without this,
     readonly users would still see admin controls. */
  [hidden] { display: none !important; }
  button { font-family: inherit; }
  input, select, textarea { font-family: inherit; font-size: 16px; } /* 16px prevents iOS zoom-on-focus */
  footer { margin-top: 1.5rem; color: var(--muted); font-size: .75rem; text-align: center; }
  .ev-card { background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: .6rem .75rem; }
  .ev-team-col { background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: .5rem; min-height: 120px; display: flex; flex-direction: column; gap: .25rem; }
  .ev-row { display: flex; flex-direction: column; gap: .15rem; padding: .3rem .4rem; border-radius: 4px; border: 1px solid transparent; }
  .ev-row:hover { background: var(--panel); }
  .ev-row.main { font-weight: 500; border-color: rgba(74, 222, 128, .25); }
  .ev-row.sub { color: var(--muted); border-color: rgba(217, 200, 112, .2); }
  .ev-row-top { display: flex; align-items: baseline; gap: .5rem; min-width: 0; }
  .ev-row-top .ev-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ev-row-top .ev-slot { width: 1.8rem; text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); flex-shrink: 0; }
  .ev-row-top .ev-power { font-variant-numeric: tabular-nums; font-size: .8rem; color: var(--muted); flex-shrink: 0; }
  .ev-row-bot { display: flex; flex-wrap: nowrap; align-items: center; gap: .3rem; min-width: 0; }
  .ev-row-bot > * { min-width: 0; flex-shrink: 1; }
  .ev-row-bot .pill { min-width: 0; max-width: 6.5rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-shrink: 0; }
  .ev-row-bot select, .ev-row-bot input { min-height: 30px; font-size: .8rem; background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: .15rem .4rem; }
  .ev-row-bot select { min-width: 5rem; flex-shrink: 0; }
  .ev-row-bot input.ev-strategy-input { flex: 1 1 0; min-width: 3rem; }
  @media (max-width: 600px) {
    .ev-row-bot { flex-wrap: wrap; }
    .ev-row-bot select { flex: 1 1 100%; min-width: 0; }
    .ev-row-bot input.ev-strategy-input { flex: 1 1 100%; min-width: 0; width: auto; }
    .ev-row-bot .pill { max-width: 100%; }
    /* Trim noisy columns in the registrations table on phones. Notes are
       best read in the dialog. */
    #ev-reg-table th.ev-notes-col, #ev-reg-table td.ev-notes-col { display: none; }
  }
  @media (max-width: 700px) {
    body { padding: .6rem; }
    h1 { font-size: 1.15rem; }
    .panel { padding: .65rem; border-radius: 6px; }
    nav.tabs button { padding: .5rem .55rem; font-size: .85rem; }
    .filters { gap: .4rem; }
    .filters label { font-size: .8rem; }
    .filters input, .filters select { font-size: .85rem; padding: .3rem .4rem; }
    .filters input[type=number] { width: 3.6rem; }
    table { font-size: .8rem; }
    th, td { padding: .35rem .35rem; }
    th { font-size: .75rem; }
    .pill { font-size: .7rem; padding: .05rem .35rem; }
    /* Hide last-date columns on phones; waiting-day pills stay visible. */
    #active-table th:nth-child(2), #active-table td:nth-child(2),
    #active-table th:nth-child(3), #active-table td:nth-child(3) { display: none; }
    #pick-eligible-list { grid-template-columns: 1fr !important; max-height: 50vh !important; }
    .filters .spacer { display: none; }
    .filters > button { flex: 1 1 auto; min-width: 6rem; }
  }`;
