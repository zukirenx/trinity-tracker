# Trinity Tracker — Discord Bot (Last War alliance tracker)

Serverless Discord bot + web dashboard for a Last War alliance. It tracks train-driver rewards and VIP handoffs from a Discord log channel, keeps a persistent train queue, runs Canyon Storm / Desert Storm event registrations and rosters, and serves a token-gated web dashboard (“Trinity Alliance Tracker”).

- **Runtime:** Cloudflare Workers (TypeScript, free tier is enough)
- **Storage:** Cloudflare D1 (SQLite, persistent)
- **Discord:** slash commands (`/train-queue`, `/help`) + automatic scheduled posts
- **Dashboard:** same Worker serves `GET /` with admin and read-only tokens
- **Tests:** Vitest, ~15 test files, real SQLite via `better-sqlite3` in tests

---

## 1. What you get

### Discord side

| Command | Who sees it | What it does |
| --- | --- | --- |
| `/train-queue` | everyone | Mobile-friendly view of the current train queue (position, member, days waiting). |
| `/help` | everyone | Prints the read-only dashboard link plus a summary of public features. |

Most officer work happens in the **web dashboard**, not in slash commands:

- **Active players** — roster with last train / last VIP and days waiting. Refresh re-ingests the tracking channel.
- **Train queue** — reorder the queue manually; the bot also auto-rotates members after each new train reward.
- **Events** — open Canyon / Desert Storm registrations, collect IN/OUT/MAYBE + squad power + team/time preferences, generate suggested rosters, lock and post rosters to Discord.
- **Random train pick** — eligible roster (no train in last N days) with checkboxes, randomized pick list, copy-to-clipboard.
- **Leaderboard history** — browse uploaded leaderboards (title + slug, newest first).
- **Upload leaderboard** — paste OCR JSON (see §7), set name + slug, run missing-member maintenance (keep / deactivate / merge).

### Automation (Worker scheduled triggers)

`wrangler.toml` defines three crons:

- `0 0 * * FRI` — create next week’s Canyon Storm event + post “registration open” to the roster channel.
- `0 0 * * SAT` — create next week’s Desert Storm event + post “registration open”.
- `0 2 * * *` — daily 02:00 UTC (midnight at UTC-2 game-server time): auto-lock every open event past `registrationClosesAt` and post its roster. Events without saved assignments are skipped. Re-posts are suppressed by roster hash.

### Data model (D1, see `schema.sql`)

- `members` + `member_aliases` — alliance roster, survives re-ingests.
- `rewards` — parsed `DD.MM NAME + VIP` lines, UNIQUE(date, driver, vip, type).
- `train_queue` + `train_queue_log` — ordered queue + strictly replayable audit journal (deploy blocks if the log cannot reproduce the live queue; see `npm run verify:queue-log-replay`).
- `leaderboards` + `leaderboard_entries` — uploaded rankings by slug.
- `poc_events_*` — events, registrations, assignments, participation log, settings.
- `metadata` — ingestion state.

---

## 2. Prerequisites

- **Node.js 18+** and npm (`node --version`, `npm --version`).
- **Git**.
- A **Cloudflare account** (free tier works). You will use Workers + D1.
- A **Discord server where you are admin**, plus the ability to create a Discord application.
- Wrangler is a devDependency — use it via `npx wrangler …`, no global install needed.

---

## 3. Discord setup (step by step)

Do this once. Keep the values — you will paste them into `.env` (local) and into Cloudflare secrets (production).

### 3.1 Enable Developer Mode (to copy IDs)

1. Discord app → User Settings → Advanced → enable **Developer Mode**.
2. From now on you can right-click any server/channel → **Copy Server ID / Copy Channel ID**.

### 3.2 Create the application + bot user

1. Go to <https://discord.com/developers/applications> → **New Application** → name it (e.g. `Trinity Tracker`).
2. Left menu → **General Information** → copy:
   - `APPLICATION ID` → `DISCORD_APPLICATION_ID`
   - `PUBLIC KEY` → `DISCORD_PUBLIC_KEY`
3. Left menu → **Bot** → **Reset Token** → copy the token → `DISCORD_BOT_TOKEN`. You only see it once — store it immediately.
4. On the same **Bot** page, enable the privileged intent:
   - **Message Content Intent** → ON (required: the bot reads reward-log text). Save.
   - `Server Members Intent` is not required.
5. Decide on three channels in your Discord server (create them if needed):
   - **Tracking channel** — where officers post reward lines like `07.12 Player + VIP`. Copy its ID → `TRACKING_CHANNEL_ID`.
   - **Roster channel** — where the bot posts registration-open announcements and locked rosters. Copy its ID → `ROSTER_CHANNEL_ID`. You may reuse the tracking channel; if `ROSTER_CHANNEL_ID` is unset the bot falls back to `TRACKING_CHANNEL_ID`.
   - **Leaderboard channel** (optional) — where weekly leaderboard screenshots are posted. Copy its ID → `LEADERBOARD_CHANNEL_ID` (used only by `scripts/leaderboard-to-text.ts`).
6. Right-click your server → Copy Server ID → `GUILD_ID`.

### 3.3 Invite the bot

1. Developer Portal → your app → **OAuth2 → URL Generator**.
2. Scopes: check **`bot`** and **`applications.commands`**.
3. Bot permissions: check **`View Channels`**, **`Read Message History`**, **`Send Messages`**, **`Use Slash Commands`**.
4. Open the generated URL, pick your server, authorize.
5. Important: in the server, make sure the bot’s role (or the bot user directly) has **View Channel + Read Message History** on the tracking channel. Channel-level overrides beat role-level grants — if ingestion sees empty message content, this is the first thing to check.

### 3.4 Interactions Endpoint URL (do after first deploy)

Discord must know where to send slash-command interactions:

1. Deploy the Worker first (see §4), note its URL, e.g. `https://lw-discord-bot.<your-subdomain>.workers.dev`.
2. Developer Portal → your app → **General Information → Interactions Endpoint URL** → paste `https://<your-worker-host>/interactions` (the exact path depends on your route; this project answers Discord interactions at the Worker root — if you changed routing, use whatever path verifies signatures).
3. Click Save — Discord will POST a PING and expect a signed PONG. If verification fails, your `DISCORD_PUBLIC_KEY` secret is wrong or the Worker is not deployed yet.

> Where secrets come from, in one place:
> `DISCORD_PUBLIC_KEY` + `DISCORD_APPLICATION_ID` ← General Information;
> `DISCORD_BOT_TOKEN` ← Bot → Reset Token;
> `GUILD_ID` / `TRACKING_CHANNEL_ID` / `ROSTER_CHANNEL_ID` / `LEADERBOARD_CHANNEL_ID` ← right-click Copy ID.

---

## 4. Cloudflare setup (step by step)

### 4.1 Log in and create D1

```bash
npm install
npx wrangler login
npx wrangler d1 create lw-rewards
```

Wrangler prints a `database_id`. Paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "lw-rewards"
database_id = "PASTE_YOUR_ID_HERE"
```

Then apply the schema and verify:

```bash
npx wrangler d1 execute lw-rewards --file=./schema.sql
npx wrangler d1 execute lw-rewards --command="SELECT name FROM sqlite_master WHERE type='table'"
```

You should see `members`, `rewards`, `train_queue`, `leaderboards`, `poc_events_event`, etc. The local dev database (`wrangler dev`) is separate and lives under `.wrangler/state/` — production uses the bound D1 above.

### 4.2 Set Worker secrets

Local `.env` is only for scripts like `register-commands`. Production reads Cloudflare secrets:

```bash
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put DISCORD_APPLICATION_ID
npx wrangler secret put TRACKING_CHANNEL_ID
npx wrangler secret put GUILD_ID
# optional (falls back to TRACKING_CHANNEL_ID when omitted):
npx wrangler secret put ROSTER_CHANNEL_ID
# optional dashboard tokens (see §6); alternatively use npm run web:link:*:rotate:
npx wrangler secret put WEB_ACCESS_TOKEN
npx wrangler secret put WEB_READONLY_TOKEN
# optional public URL used in auto-posts ("Dashboard: <url>?token=..."):
npx wrangler secret put WORKER_URL
```

Each command prompts for the value (paste, Enter). Wrangler never lets scripts read secret values back — `scripts/web-link.ts` therefore mirrors dashboard tokens to gitignored `.wrangler/web-token*` files whenever it sets them.

### 4.3 Deploy

```bash
npm run deploy
```

`deploy` = `npm run test` + `npm run verify:queue-log-replay` + `wrangler deploy`. It aborts if tests fail or if the remote `train_queue_log` cannot strictly reproduce the live queue. After deploy, Wrangler prints your `https://…workers.dev` URL — use it for the Interactions Endpoint (§3.4) and for `WORKER_URL`.

Cron triggers from `wrangler.toml` are registered automatically on deploy (Fri/Sat creation + daily 02:00 UTC auto-lock).

---

## 5. Local setup

```bash
npm install
cp .env.example .env   # then fill in your IDs/tokens
npm run dev            # http://127.0.0.1:8787 (local D1, separate from prod)
npm run test           # Vitest suite
npm run lint           # tsc --noEmit
npm run register:commands  # push /train-queue + /help to your guild
```

Notes:

- `register-commands.ts` reads local `.env` (dotenv), **not** Cloudflare secrets. Keep `.env`’s `GUILD_ID` / `DISCORD_APPLICATION_ID` correct before running it. After editing `src/commandDefinitions.ts`, run `register:commands` **and** `deploy` — otherwise Discord shows a command the Worker cannot handle (“Unknown command”).
- Never commit `.env`. Only `.env.example` (empty values) belongs in git.

---

## 6. Web dashboard + tokens

The same Worker serves the dashboard at `GET /`, gated by token (`?token=` query or `Authorization: Bearer`). Two roles:

- **Admin token** (`WEB_ACCESS_TOKEN`) — full dashboard.
- **Read-only token** (`WEB_READONLY_TOKEN`) — subset safe to share with the alliance. `/help` prints the read-only link.

Manage them with the bundled CLI (values are pushed to Cloudflare and mirrored to `.wrangler/web-token*`, which is gitignored):

```bash
npm run web:link                # print current admin link (generates one if none exists)
npm run web:link:rotate         # new admin token -> Cloudflare -> print link
npm run web:link:readonly       # print current read-only link (generates one if none exists)
npm run web:link:readonly:rotate
```

Tokens are always auto-generated on rotate — there is no way to set an
explicit value, so a rotated-out token can never be reinstated through this CLI.

Override the base URL with `--url https://your-worker…` or `WEB_URL` in `.env` / `CF_WORKERS_SUBDOMAIN` for the default `workers.dev` construction.

If no token is configured the dashboard returns 503 with a hint to set the secret.

---

## 7. Leaderboard workflow

Screenshots → JSON → D1. The OCR step is intentionally external (any vision model that emits `[{Ranking, Commander, Points}]` works; the previous maintainer’s local llama.cpp script is **not** included in this repo).

1. **Download screenshots** (needs `DISCORD_BOT_TOKEN` + channel):

   ```bash
   npx tsx scripts/leaderboard-to-text.ts --leaderboards=1 --messages=20
   # or: --channel=<id> --outDir=./tmp/leaderboard
   ```

   Saves each leaderboard pair into `tmp/leaderboard/leaderboard-N-<timestamp>/` (gitignored). `--leaderboards` max 50, `--messages` max 100 (Discord API limit).

2. **Convert screenshots to JSON** with any VLM using this prompt (also shown inline on the dashboard Upload tab with a Copy button):

   > These are screenshots of leaderboard in the Last War online game. Parse them and create a table in JSON format containing this leaderboard, using the fields Ranking, Commander, and Points. Return only the JSON array, without any commentary.

   Expected shape: `[{"Ranking": 1, "Commander": "Name", "Points": 12345}, …]` (lowercase keys accepted).

3. **Upload JSON to D1**:

   ```bash
   npx tsx scripts/upload-leaderboard.ts \
     --input tmp/leaderboard/leaderboard-ww01-26.json \
     --slug ww01-2026 \
     --week 1 \
     --year 2026 \
     --source leaderboard-ww01-26.json \
     --update-members \
     --remote
   ```

   Flags: `--input/--json` (required), `--slug` (defaults to filename), `--week/--year` or explicit `--week-start/--week-end`, `--title`, `--source`, `--points-multiplier N` (or `--x6`), `--env <name>` (wrangler environment), `--database <name>` (default `lw-rewards`), `--dry-run` (preview), `--update-members` (interactive missing-member cleanup), `--maintenance-only --slug …` (re-run cleanup), `--remote` (write to prod; omit for local D1).

4. **Verify**:

   ```bash
   npx wrangler d1 execute lw-rewards --remote --command "SELECT COUNT(*) FROM leaderboard_entries WHERE leaderboard_id = (SELECT id FROM leaderboards WHERE slug='ww01-2026');" --json
   ```

You can also upload directly from the dashboard **Upload leaderboard** tab (paste JSON, set Name + Slug, submit, then resolve missing members inline). Uploads from the dashboard are tagged `source = 'web-interface'`.

### 7a. Score review (queue penalties + Desert Storm bans)

After missing members are resolved (Keep / deactivate / merge), the dashboard opens a **Score review** dialog for the uploaded leaderboard:

- **Below minimum** (off by default; minimum defaults to `7.2M`): every player below the minimum moves **down** the train queue (away from #1) by N spots (N defaults to 1).
- **Above maximum** (off by default; maximum unset by default): every player above the maximum moves down with an escalating penalty — base −1, −1 more per full M points of excess (M defaults to `1M`), capped at −X spots (X defaults to 5). Example with max `10M`: `11.9M` → −2, `14.9M` → −5, `20M` → −5 (capped).
- Equality with a threshold never penalises. Points accept `M`/`k` suffixes (`7.2M`).
- **Preview first, then apply.** The preview lists every penalised player (commander, points, −N, reason, capped flag). Apply / Confirm-bans stay disabled until the preview matches the current settings — changing any value forces a re-preview, so you can never apply something different from what was shown. Applying writes one `train_queue_log` entry per move (replay-safe) and **can be done only once per leaderboard** — a second apply returns `409`.
- **Regular offenders.** Players who hit the max cap Y leaderboards **in a row** (Y defaults to 2, adjustable per review) are listed with checkboxes (all checked; uncheck to exclude anyone). Confirming applies a **Desert Storm ban** with these guarantees, also shown in the dialog:
  - the ban hits **only the next Desert Storm with open registration** (the DS with closed registration is explicitly named as NOT affected; late registrants are banned automatically on sign-up);
  - the ban happens **exactly once per player** — confirming two leaderboards for the same upcoming DS bans once (`UNIQUE(member_id, target_event_id)`);
  - if no DS has open registration, bans are **queued** and attached to the next DS when it opens (Saturday cron).
- **Resume.** Closing the dialog loses nothing: the leaderboard stays uploaded and the review appears under **Unfinished score reviews** (top of the Upload tab) until both steps are done or skipped. Queue penalties and DS bans are tracked independently (`leaderboard_score_reviews.penalties_status` / `bans_status`). **Skip entire review** in the dialog footer dismisses both steps at once with no preview needed.
- **Defaults** live in **Settings → Leaderboard score penalties** (min, below-min N, max, step M, cap X, streak Y), stored as `setting:score_*` in `metadata`. The dialog always starts with both rules disabled; the settings only prefill the values.

Tables: `leaderboard_score_reviews` (one-shot state per slug), `leaderboard_score_penalties` (per-player applied/capped rows, feeds streaks), `leaderboard_ds_bans` (ban queue + dedup). API (admin-only): `POST /api/leaderboard-score-preview|apply|bans|skip`, `GET /api/leaderboard-score-status|pending`.

---

## 8. Tests + deployment workflow

```bash
npm run test              # full Vitest suite (storage, parsers, queue, events, web routing, i18n)
npx vitest run --coverage # with coverage
npm run verify:queue-log-replay  # strict replay of REMOTE train_queue_log vs live queue
npm run deploy            # test + verify + wrangler deploy
```

Conventions (enforced by review, not by tooling):

- Every feature/fix ships with tests: `DataStore` changes → `tests/storage-d1.test.ts` (or a focused file); web routes → `tests/webRouting.test.ts`; parsers/formatters → the matching unit test file; bug fixes → a regression test that fails on the old code.
- D1 tests use `better-sqlite3` via `tests/d1-mock.ts` (real SQLite, FKs on) — prefer it over hand mocks. `TZ=UTC` is set in `vitest.config.ts` to match Workers.
- `train_queue_log` invariant: every mutation of `train_queue` must emit a matching log row with exact `from_pos`/`to_pos` (`add` inserts at `to_pos`; `remove`/`merge-remove` splice from `from_pos`; `auto-train`/`manual-move`/`merge-move` splice + insert; `rename` is cosmetic). Hand-editing the log requires re-running the verifier before deploy.
- Back up remote D1 before direct data mutations:

  ```powershell
  npx wrangler d1 export lw-rewards --remote --output "backups/lw-rewards-remote-backup-$(Get-Date -Format 'yyyy-MM-ddTHH-mm-ss')Z.sql"
  ```

  `backups/` is gitignored — keep the file locally until you are sure the mutation is correct.

---

## 9. Project structure

```text
src/
  index.ts              # Worker entrypoint (Discord verification, slash commands, web routes, crons)
  storage.ts            # D1 store: members, rewards, train queue, leaderboards
  eventsStore.ts        # D1 store: events, registrations, assignments, participation, settings
  commandDefinitions.ts # /train-queue + /help schemas
  register-commands.ts  # Push command schemas to the guild (reads local .env)
  utils/
    rewardParser.ts     # "DD.MM NAME + VIP" parsing + date resolution
    normalizer.ts       # Name normalization (diacritics, 0->o, case)
    format.ts           # Dates, Discord table formatting
    eventSuggest.ts     # Roster suggestion + Canyon/Desert strategy roles
  web/
    page.ts             # Dashboard assembler (renderPage)
    page/               # styles, body, script, client fragments, i18n (en/fr/de/ru/it)
scripts/
  leaderboard-to-text.ts     # Download leaderboard screenshots from Discord
  upload-leaderboard.ts      # Upload OCR JSON to D1 (+ member maintenance)
  verify-queue-log-replay.cjs# Strict replay check for train_queue_log (runs on deploy)
  web-link.ts                # Manage WEB_*_TOKEN secrets + print dashboard links
tests/                  # Vitest suite (d1-mock + 14 test files)
schema.sql              # Full D1 schema + migration comments
wrangler.toml           # Worker config, D1 binding, cron triggers
.env.example            # Empty template — copy to .env, never commit .env
```

Deliberately **not** in this repo: `.env`, `.wrangler/`, `backups/`, `tmp/`, screenshots, database exports, `node_modules/`, editor settings, and the previous maintainer’s local llama.cpp OCR script (see §7 for the model-agnostic replacement).

---

## 10. Troubleshooting

- **Interactions Endpoint fails verification** — `DISCORD_PUBLIC_KEY` secret is wrong, or the Worker isn’t deployed yet. Re-check General Information → Public Key vs `wrangler secret put DISCORD_PUBLIC_KEY`.
- **Ingestion sees empty message content** — enable **Message Content Intent** (Bot page) and grant the bot channel-level **View Channel + Read Message History** on the tracking channel.
- **Slash commands missing** — re-run `npm run register:commands`, confirm the invite included the `applications.commands` scope, wait ~1 min, restart Discord.
- **D1 errors / wrong database** — `database_id` in `wrangler.toml` must match `wrangler d1 create` output; `wrangler dev` uses a separate local D1 under `.wrangler/state/`.
- **Dashboard 503 “not configured”** — set `WEB_ACCESS_TOKEN` / `WEB_READONLY_TOKEN` (or rotate via `npm run web:link:*:rotate`).
- **Deploy blocked by queue-log replay** — a `train_queue` mutation was logged with wrong `from_pos`/`to_pos`. Inspect `train_queue_log` (ordered by `ts, id`), fix the rows, re-run `npm run verify:queue-log-replay`.
- **`--tester` npm scripts missing** — intentionally removed; use the `:readonly` variants in §6.

---

## 11. New-maintainer checklist

1. Create your Discord app + bot (§3), Cloudflare Worker + D1 (§4).
2. `npm install`, `cp .env.example .env`, fill IDs, `npm run register:commands`, `npm run deploy`.
3. Set the Interactions Endpoint URL (§3.4), run `/help` in Discord to confirm the bot answers.
4. Rotate both dashboard tokens (`npm run web:link:rotate`, `npm run web:link:readonly:rotate`) and share only the read-only link.
5. Post a test reward line in the tracking channel, refresh the dashboard, check the queue moves.
6. Create a test Canyon/Desert event in the dashboard, register two accounts, generate + lock + verify the roster post.

## License

MIT — see [LICENSE](LICENSE).
