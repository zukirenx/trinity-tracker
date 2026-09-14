// CLI helper to read/rotate the WEB_ACCESS_TOKEN secret used by the
// dashboard, and to print the full shareable link. Tokens are always
// auto-generated (cryptographic random) — there is deliberately no way to set
// an explicit value, so a rotated-out token can never be reinstated.
//
// Usage:
//   tsx scripts/web-link.ts                       # print current link (generates one if none exists)
//   tsx scripts/web-link.ts --rotate              # generate new token, deploy, print link
//   tsx scripts/web-link.ts --url <url>           # override base URL
//
// Wrangler does not let us read secret *values* back from Cloudflare, so the
// token is mirrored locally to .wrangler/web-token (gitignored) whenever we
// set it. The default action reads from that file.

import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const TOKEN_FILE_ADMIN = resolve(PROJECT_ROOT, '.wrangler', 'web-token');
const TOKEN_FILE_READONLY = resolve(PROJECT_ROOT, '.wrangler', 'web-token-readonly');
const URL_FILE = resolve(PROJECT_ROOT, '.wrangler', 'web-url');
const WRANGLER_TOML = resolve(PROJECT_ROOT, 'wrangler.toml');

interface Args {
  rotate: boolean;
  url: string | null;
  readonly: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { rotate: false, url: null, readonly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rotate' || a === '-r') args.rotate = true;
    else if (a === '--url') args.url = argv[++i] ?? null;
    else if (a === '--readonly' || a === '--read-only') args.readonly = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      log(`✗ Unknown argument: ${a}`);
      usage();
      process.exit(2);
    }
  }
  return args;
}

function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

function readWranglerName(): string | null {
  if (!existsSync(WRANGLER_TOML)) return null;
  const text = readFileSync(WRANGLER_TOML, 'utf8');
  const match = text.match(/^\s*name\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

function resolveBaseUrl(override: string | null): string {
  if (override) return override.replace(/\/+$/, '');
  if (process.env.WEB_URL) return process.env.WEB_URL.replace(/\/+$/, '');
  if (existsSync(URL_FILE)) {
    const saved = readFileSync(URL_FILE, 'utf8').trim();
    if (saved) return saved.replace(/\/+$/, '');
  }
  const name = readWranglerName();
  const subdomain = process.env.CF_WORKERS_SUBDOMAIN;
  if (name && subdomain) {
    return `https://${name}.${subdomain}.workers.dev`;
  }
  if (name) {
    return `https://${name}.<your-subdomain>.workers.dev`;
  }
  return 'https://<worker-host>';
}

function writeLocalUrl(baseUrl: string): void {
  mkdirSync(dirname(URL_FILE), { recursive: true });
  writeFileSync(URL_FILE, baseUrl.replace(/\/+$/, '') + '\n');
}

function readLocalToken(file: string): string | null {
  if (!existsSync(file)) return null;
  const value = readFileSync(file, 'utf8').trim();
  return value || null;
}

function writeLocalToken(file: string, token: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token + '\n', { mode: 0o600 });
}

function pushSecret(name: string, token: string): void {
  log('• Updating Cloudflare secret ' + name + ' via wrangler …');
  const isWindows = process.platform === 'win32';
  // On Windows wrangler ships as wrangler.cmd, which needs shell: true to be
  // located via PATH. On POSIX we keep shell off to avoid quoting surprises.
  const result = spawnSync(
    isWindows ? 'npx.cmd' : 'npx',
    ['wrangler', 'secret', 'put', name],
    {
      cwd: PROJECT_ROOT,
      input: token + '\n',
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: isWindows,
    },
  );
  if (result.error) {
    log('✗ Failed to launch wrangler: ' + result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    log('✗ wrangler exited with status ' + result.status);
    process.exit(result.status ?? 1);
  }
}

function generateToken(secretName: string, tokenFile: string): string {
  const token = randomBytes(24).toString('hex');
  pushSecret(secretName, token);
  writeLocalToken(tokenFile, token);
  return token;
}

function printLink(base: string, token: string): void {
  // URL on stdout — easy to copy/pipe. Diagnostics go to stderr.
  process.stdout.write(`${base}/?token=${encodeURIComponent(token)}\n`);
}

function usage(): void {
  process.stderr.write(
`Usage:
  tsx scripts/web-link.ts                         # print current admin link (generates one if none exists)
  tsx scripts/web-link.ts --readonly              # print current read-only link (generates one if none exists)
  tsx scripts/web-link.ts --rotate                # generate new token and push to Cloudflare
  tsx scripts/web-link.ts --url <baseUrl>         # override the base URL
Env:
  WEB_URL                Base URL of the deployed Worker (overrides wrangler.toml).
  CF_WORKERS_SUBDOMAIN   Your workers.dev subdomain (used to construct URL).
`
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const base = resolveBaseUrl(args.url);
  const secretName = args.readonly ? 'WEB_READONLY_TOKEN' : 'WEB_ACCESS_TOKEN';
  const tokenFile = args.readonly ? TOKEN_FILE_READONLY : TOKEN_FILE_ADMIN;
  const label = args.readonly ? 'read-only ' : '';
  const roleLabel = args.readonly ? 'Read-only token' : 'Token';

  if (args.rotate) {
    const token = generateToken(secretName, tokenFile);
    log('✓ ' + roleLabel + ' rotated and saved to ' + tokenFile);
    printLink(base, token);
    return;
  }

  // Default: print current link from local mirror, generating a token first
  // when none exists yet.
  let token = readLocalToken(tokenFile);
  if (!token) {
    log('• No local ' + label + 'token found — generating a new one …');
    token = generateToken(secretName, tokenFile);
    log('✓ ' + roleLabel + ' generated and saved to ' + tokenFile);
  }
  printLink(base, token);
}

main();
