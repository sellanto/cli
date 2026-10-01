#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// YOUR STORE'S THEME, ON YOUR OWN COMPUTER
// ═══════════════════════════════════════════════════════════════════════════
//
// WHO THIS FILE IS FOR
// ────────────────────
// The STORE OWNER and their developer, not the platform. It touches neither
// the Sellanto repository nor any server: it talks to one store's public API
// and uploads the files of THAT store's theme.
//
// Until now the only way to reach those files was a text box in the admin,
// one file at a time. Anyone with their own editor, their own git and an eye
// on the whole file had no way to work. Now there is one.
//
// ⚠ UPLOADED IS NOT LIVE. `push` and `watch` write to a DRAFT: the storefront
// shows it only at the signed URL that `preview` prints. The store's customers
// keep seeing the old version until you say `publish`. That is deliberate —
// under `watch` every Ctrl+S is a request, including one over a half-written
// template, and that must not reach a live store.
//
// GETTING STARTED
// ───────────────
//   1. Install the command:
//
//        npm i -g github:sellanto/cli
//
//      ⚠ From the REPOSITORY, not from the npm registry. The registry is one
//      more place a different file could come from; `selfupdate` pulls from
//      THE STORE ITSELF, so the command heals itself against the API it talks
//      to.
//
//   2. In the folder where you want the theme:
//
//        sellanto login            # browser: pick a store and approve
//        sellanto pull
//
//   3. Write with whatever you write with. Then:
//
//        sellanto watch            # uploads on every save
//        sellanto preview          # the URL where it shows
//        sellanto publish          # only now do customers see it
//
// THE COMMANDS
// ────────────
//   login     Gets a key through the browser and writes it here.
//   init      Writes `.sellanto.json` by hand (API address, store, version).
//   use       Switches which theme you are working on.
//   themes    Which themes this account may edit — including the shipped ones.
//   pull      Downloads the theme into the current folder, delivered files too.
//   status    What differs from what the store has.
//   push      Uploads the differences into the draft.
//   watch     The same, on every save.
//   preview   The URL where the draft can be seen.
//   publish   The draft becomes live.
//   discard   Throws the draft away; the live files are untouched.
//   diff      What you changed against the DELIVERED theme.
//   conflicts Which of your files are copies of a file the platform has since
//             changed.
//   versions  The history of one file.
//   restore   Puts a file back — to a numbered version, or to the theme's own.
//   docs      Rewrites the reference and the agent brief under `.sellanto/`.
//   selfupdate Replaces this file with the one the store serves.
//
// ⚠ NOT ONE DEPENDENCY. This file is handed to a merchant who does not want to
//   learn what `npm install` means — so, built-in Node modules only.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import child from 'node:child_process';

/**
 * THE TOOL'S VERSION — one source.
 *
 * ⚠ THIS LINE IS ALSO READ BY THE PLATFORM (`ThemeCliController::versionOf()`),
 * so that the version does not exist in two places. Its shape is a contract:
 * `const VERSION = '…';` on its own line, no indentation.
 *
 * The value is a date, with `.N` for a second fix on the same day: `selfupdate`
 * compares STRINGS, so an unchanged version over changed content means "you are
 * already on the newest" told to someone holding the old text.
 */
const VERSION = '2026-10-01';

const CONFIG = '.sellanto.json';
const TOKEN_FILE = '.sellanto.token';

// The directories the API recognises at all (`ThemeCustomizations::DIRECTORIES`).
// This copy exists for WALKING THE DISK, not as a second rule: the rule lives on
// the server and refuses by name. Here it only keeps `watch` out of node_modules.
const DIRECTORIES = [
  'layouts', 'templates', 'sections', 'snippets',
  'blocks', 'assets', 'locales', 'config',
];

const EXTENSIONS = ['.twig', '.json', '.css', '.js', '.txt', '.md'];

/**
 * The hosts that ARE the platform. A key exchange and a self-update go to one of
 * these and nowhere else (security audit 2026-09-30, F1 + F2).
 *
 * ⚠ A LURED APPROVAL PAGE CHOOSES `api`. The callback on 127.0.0.1 carries the
 * address the key is then collected from — and the page that sent the browser
 * there may be a fake dashboard. Without this list the tool handed its PKCE
 * secret to whatever host that page named. The same list stops `selfupdate`
 * from replacing the tool with bytes served by a mistyped `--api` or by a
 * store's own custom domain, whose DNS the platform does not control.
 */
const PLATFORM_HOSTS = ['sellanto.com'];
const PLATFORM_SUFFIXES = ['.sellanto.com', '.sellantoshop.dev'];

const isLoopback = (host) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)
  || host.endsWith('.localhost')
  || host.endsWith('.test');

function isPlatform(address) {
  let url;

  try { url = new URL(address); } catch { return false; }

  const host = url.hostname.toLowerCase();

  return url.protocol === 'https:'
    && (PLATFORM_HOSTS.includes(host) || PLATFORM_SUFFIXES.some((suffix) => host.endsWith(suffix)));
}

/** A theme slug or a store id — the two values glued into request paths (audit F3). */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/* ═══════════════════════════════════════════════════════════════════════════
   Small things
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠ UNDER `--json`, PROSE GOES TO stderr AND ONLY THE PAYLOAD TO stdout.
 *
 * `--json` exists so an assistant does not have to parse prose. But the tool
 * also says useful things along the way — "the store renders another theme",
 * "a newer version exists" — and printed to stdout they land in front of the
 * JSON, where `| jq` dies on the first line. Two streams is the answer Unix
 * already has: a person reads both, a parser reads one.
 */
const MACHINE = process.argv.includes('--json');

const say = (...a) => (MACHINE ? console.error(...a) : console.log(...a));

/** The machine payload — always stdout, whatever else is going on. */
const emit = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

const die = (m) => { console.error('\n  ✗ ' + m + '\n'); process.exit(1); };

/**
 * HOW THE TOOL WAS INVOKED — so its advice uses the same words.
 *
 * Three forms reach here and all three are legitimate: `sellanto` (on PATH),
 * `./sellanto-theme.mjs` (the executable bit and the shebang) and
 * `node sellanto-theme.mjs`. Advice that prints the third to someone who typed
 * the first is advice that cannot be copied — and copying is the whole point.
 *
 * ⚠ For a global install argv[1] is the file INSIDE `node_modules`, not the
 * shim npm put on PATH. So the folder is what gets asked, not just the name.
 */
const ME = (() => {
  const self = process.argv[1] ?? '';

  if (self.split(path.sep).join('/').includes('/node_modules/')) return 'sellanto';

  const base = path.basename(self);

  if (base === '') return 'sellanto';

  return /\.(mjs|cjs|js)$/.test(base) ? `node ${base}` : base;
})();

const files = (n) => (n === 1 ? '1 file' : `${n} files`);

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Writes the settings.
 *
 * ⚠ One writer, because learned things land here too (the theme, the reference
 * checksum, when the version was last checked). Three places writing the file
 * are three chances for one of them to drop another one's field.
 */
/**
 * ⚠ `storeTheme` IS RUNTIME-ONLY and is stripped here, at the one door to the
 * file. It is asked on every run (see `main`); remembered on disk it becomes a
 * second answer to "what does the store render", and the copy is the one that
 * goes stale.
 */
function saveConfig(cfg) {
  const { storeTheme: _live, ...rest } = cfg;

  cfg = rest;

  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function config() {
  if (!fs.existsSync(CONFIG)) {
    die(`No ${CONFIG} here. Run this first:\n     ${ME} login`);
  }

  /*
  | ⚠ THIS FILE GETS HAND-EDITED — the documentation itself says to put
  | `"autoUpdate": true` in it. One forgotten comma and the person used to see a
  | SyntaxError with a stack, so they could not tell the mistake was theirs and
  | one character wide.
  */
  let raw;

  try {
    raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch (e) {
    die(`${CONFIG} is not valid JSON: ${e.message}`);
  }

  if (!raw.api || !raw.store) die(`${CONFIG} has no \`api\` or no \`store\`.`);

  return { version: '2026-07', ...raw };
}

/**
 * The key — from the environment or from a file, NEVER from `.sellanto.json`.
 *
 * ⚠ Split on purpose: `.sellanto.json` describes WHERE things are uploaded and
 * belongs in git; the key is a secret and must not follow it there. That is why
 * `login` and `init` also write a line into `.gitignore`.
 */
function token() {
  const fromEnv = process.env.SELLANTO_TOKEN;
  if (fromEnv) return fromEnv.trim();

  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();

  die(`No key. Put it in the environment:\n     export SELLANTO_TOKEN="…"\n   or in the file ${TOKEN_FILE} (which stays out of git), or run \`${ME} login\`.`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   The API
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * One call. Returns the parsed response, or fails with the SENTENCE of the
 * refusal.
 *
 * ⚠ THE REFUSAL IS READ, NOT REDUCED TO A STATUS. The API envelope carries
 * `code`, `message`, and for an invalid file a `line` — so "line 42: unexpected
 * endfor" can be printed next to the path. "HTTP 422" would send the person off
 * to read logs.
 *
 * @param raw returns the TEXT rather than a parsed envelope — only for the tool
 *            itself, which is a script, not JSON.
 */
function call(cfg, method, route, body, retried = false, raw = false) {
  /*
  | A route with a leading `/` lives OUTSIDE `stores/{id}/`. Today that is
  | `token`, from which the store is discovered, and `cli/token`.
  |
  | ⚠ And not `../token`: `new URL` normalises the path, so counting the dots
  | becomes a silent puzzle — one level too many and the request goes to
  | `stores/token`, which is a 404 with no reason attached.
  */
  /*
  | ⚠ THE STORE ID IS GLUED INTO THE PATH, so it is checked before it is glued:
  | `.sellanto.json` is hand-edited, and `../..` there would reach a different
  | route than the one the command meant (audit F3).
  */
  if (!route.startsWith('/') && !SLUG.test(String(cfg.store ?? ''))) {
    die(`The store id \`${cfg.store}\` in ${CONFIG} does not look like one.`);
  }

  const base = `${cfg.api.replace(/\/$/, '')}/api/${cfg.version}`;
  const url = new URL(route.startsWith('/')
    ? `${base}${route}`
    : `${base}/stores/${cfg.store}/${route}`);

  /*
  | ⚠ NO HTTPS, NO KEY, for any foreign host. The `Authorization` header carries
  | a key allowed to write code onto the storefront. Under `watch` it leaves on
  | EVERY SAVE — so one mistyped `--api http://…` is hundreds of cleartext
  | exposures of that key, with nobody warned.
  |
  | Loopback is the exception, because there is no network there to listen on —
  | and without it, working against your own `artisan serve` would be impossible.
  */
  const local = isLoopback(url.hostname);

  if (url.protocol !== 'https:' && !local) {
    die([`The key will not travel over ${url.protocol} to ${url.hostname}.`, 'Change `api` in .sellanto.json to https://'].join('\n   '));
  }

  const client = url.protocol === 'http:' ? http : https;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');

  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method,
      headers: {
        /*
        | ⚠ EXACTLY ONE CALL IN THE WHOLE TOOL GOES WITHOUT A KEY: the one that
        | FETCHES the key (`login`). Everywhere else a missing key is an error
        | and `token()` exits with a sentence — so the exception is a field on
        | the settings object, not a silent fallback.
        */
        ...(cfg.anonymous === true ? {} : { Authorization: `Bearer ${token()}` }),
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* the envelope may be empty */ }

        if (response.statusCode >= 200 && response.statusCode < 300) {
          return resolve(raw ? text : (parsed?.data ?? parsed));
        }

        /*
        | ⚠ 429 IS NOT AN ERROR, IT IS A PACE — AND IT IS NOT IN THE USUAL
        | ENVELOPE.
        |
        | The default ceiling is 40 requests per minute PER ACCOUNT
        | (`storefront.api.rpm_fallback`), and one theme has about a hundred
        | files — so the first `pull` is GUARANTEED to hit it. Without this
        | branch, downloading a theme simply skipped two thirds of the files
        | with red lines.
        |
        | The refusal carries `retry_after` at the ROOT of the body (a different
        | shape from the envelope used for resource refusals) and a `Retry-After`
        | header. We wait exactly that long and try again — once, not forever: a
        | second 429 after waiting means another client on the same account, not
        | our own pace.
        */
        if (response.statusCode === 429 && !retried) {
          const wait = Number(response.headers['retry-after'] ?? parsed?.retry_after ?? 5);

          say(`  … rate limit hit, waiting ${wait}s`);

          /*
          | ⚠ `raw` TRAVELS ALONG TOO. Without it the retry parses the response
          | as JSON — and the only `raw` route today serves THE TOOL ITSELF, so
          | `selfupdate` under a hit ceiling saw `null` and said "the platform
          | did not return the tool": a false sentence at exactly the moment the
          | update mattered.
          */
          return void setTimeout(
            () => call(cfg, method, route, body, true, raw).then(resolve, reject),
            (Number.isFinite(wait) && wait > 0 ? wait : 5) * 1000,
          );
        }

        const error = parsed?.errors?.[0] ?? (parsed?.code ? parsed : null);
        const where = error?.line ? ` (line ${error.line})` : '';
        const detail = error?.detail ? ` — ${error.detail}` : '';

        reject(new Error(
          `${response.statusCode} ${error?.code ?? 'unknown'}${where}: ${error?.message ?? text.slice(0, 200)}${detail}`,
        ));
      });
    });

    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

/*
| ⚠ THE SLUG IS CHECKED BEFORE IT BECOMES PART OF A URL (audit F3). A theme
| named `../../tools/theme-cli` in `.sellanto.json` used to aim the request at a
| different route; now it is refused with a sentence and nothing is sent.
*/
const remote = (cfg, method, suffix, body) => {
  if (!SLUG.test(String(cfg.theme ?? ''))) {
    die(`The theme \`${cfg.theme}\` in ${CONFIG} is not a plain slug (letters, digits, - and _).`);
  }

  return call(cfg, method, `themes/${cfg.theme}/${suffix}`, body);
};

/* ═══════════════════════════════════════════════════════════════════════════
   The disk
   ═══════════════════════════════════════════════════════════════════════════ */

/** Every theme file in the current folder — path → contents. */
function localFiles() {
  const found = new Map();

  for (const directory of DIRECTORIES) {
    if (!fs.existsSync(directory)) continue;

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) { walk(full); continue; }

        /*
        | ⚠ REAL FILES ONLY. A symlink is neither a directory nor filtered out
        | by its extension — so a theme taken from a third party carrying
        | `sections/logo.json -> ~/.aws/credentials` would upload that into the
        | platform's database on the first `push`, with nobody having asked.
        */
        if (!entry.isFile()) continue;
        if (!EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;

        found.set(full.split(path.sep).join('/'), fs.readFileSync(full, 'utf8'));
      }
    };

    walk(directory);
  }

  return found;
}

/**
 * A path that came FROM THE SERVER — is it valid to write HERE.
 *
 * ⚠ WE DO NOT TRUST THE SERVER, AND THAT IS NOT DISTRUST OF PEOPLE. `pull`
 * takes file names out of the envelope and writes to them with the permissions
 * of whoever ran it. A response of `{"path": "../../../../.ssh/authorized_keys"}`
 * — from a mistyped address, a poisoned DNS answer or someone in between —
 * would write outside the folder. The server already protects ITSELF with the
 * same allowlist; this protects THE MERCHANT'S MACHINE, which is another border.
 *
 * Three checks, the same as the server's, plus containment by RESOLVED path:
 * a string can look innocent and still point outwards.
 */
function safeRelative(relative) {
  if (typeof relative !== 'string' || relative === '' || relative.includes('\0')) return null;

  const normal = relative.split('\\').join('/');

  /*
  | ⚠ PLAIN CHARACTERS ONLY (audit F4). `%2e%2e`, look-alike dots and the like
  | never escaped the folder — containment below holds — but they landed as
  | literal, confusing directory names. No theme file needs them.
  */
  if (!/^[A-Za-z0-9._/-]+$/.test(normal) || normal.split('/').some((part) => /^\.+$/.test(part))) return null;

  if (normal.startsWith('/') || /^[a-zA-Z]:/.test(normal) || normal.split('/').includes('..')) return null;
  if (!DIRECTORIES.includes(normal.split('/')[0])) return null;
  if (!EXTENSIONS.includes(path.extname(normal).toLowerCase())) return null;

  const root = path.resolve(process.cwd());
  const full = path.resolve(root, normal);

  return full === root || full.startsWith(root + path.sep) ? normal : null;
}

/**
 * Writes one file and says WHICH of three things happened.
 *
 * ⚠ AN UNCHANGED FILE IS NOT REWRITTEN, and that is not a micro-optimisation.
 * Two things depended on it:
 *
 *   1. `pull` could not tell "downloaded 176 files" from "176 files exist" —
 *      it always wrote all of them and always counted all of them;
 *   2. since `serve` watches the folder, rewriting every file makes the watcher
 *      upload all 176 straight back — against a ceiling of 40 requests a
 *      minute, for a folder that did not change.
 *
 * @returns 'created' · 'replaced' · 'same' · null when the path is refused
 */
function write(relative, content) {
  const safe = safeRelative(relative);

  if (safe === null) {
    say(`  ✗ path from the server skipped: ${relative}`);

    return null;
  }

  const full = path.join(process.cwd(), safe);

  let before = null;

  try {
    before = fs.readFileSync(full, 'utf8');
  } catch (e) {
    // Missing is the ordinary case on a first pull; unreadable is treated the
    // same, because the answer to both is "write it".
  }

  if (before === content) {
    return 'same';
  }

  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');

  return before === null ? 'created' : 'replaced';
}

/**
 * The key must not follow the settings into git.
 *
 * ⚠ And `.sellanto/` too — a GENERATED reference lives there and is rewritten
 * on every `pull`. Let it into git and every run produces a commit with no
 * content, burying the real change to the theme under the noise.
 *
 * ⚠ A function, not two copies: `init` and `login` do the same thing, and two
 * copies of one rule are one chance for one of them to forget `.sellanto/`.
 */
function ignore(want) {
  const have = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '';
  const missing = want.filter((one) => !have.includes(one));

  if (missing.length === 0) return;

  fs.writeFileSync(
    '.gitignore',
    `${have}${have.endsWith('\n') || have === '' ? '' : '\n'}${missing.join('\n')}\n`,
    'utf8',
  );

  say(`  ✓ .gitignore ← ${missing.join(', ')}`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Signing in with a browser
   ═══════════════════════════════════════════════════════════════════════════ */

/** Where a store gets picked — the only place that knows which ones there are. */
const CONNECT = 'https://sellanto.com/en/dashboard/cli';

/**
 * Fetches a key without the person transcribing anything.
 *
 * =========================================================================
 * FOUR STEPS, THREE PROGRAMS, AND THE SECRET PASSES THROUGH ONE
 * =========================================================================
 *   1. HERE a secret is invented and a tiny server comes up on `127.0.0.1`.
 *      The platform does not yet know anyone wants a key.
 *   2. The browser goes to the dashboard, the person picks a store and approves.
 *   3. The store sends the browser back to `127.0.0.1` — carrying only "done".
 *   4. HERE the key is collected over a SECOND connection, with that same secret.
 *
 * ⚠ THE SECRET NEVER PASSES THROUGH THE BROWSER, and that is the whole
 * difference from "copy the key off the screen". Only its hash travels there.
 * So the URL the person sees, and which lands in their history, is not enough
 * to obtain a key (PKCE, RFC 7636).
 *
 * ⚠ AND THE CODE IS PRINTED BEFORE THE BROWSER OPENS. It is the fence against
 * the one attack cryptography cannot help with: a lured URL the person approves
 * themselves. The screen on the other side shows the same characters — if they
 * do not match, they are approving someone else's request.
 */
async function login(args) {
  const base = flag(args, '--connect') ?? CONNECT;

  // The secret that stays HERE. 64 hex characters = 32 bytes of randomness.
  const verifier = crypto.randomBytes(32).toString('hex');
  const requestId = crypto.randomBytes(24).toString('base64url');
  const state = crypto.randomBytes(12).toString('base64url');
  const challenge = sha256(verifier);
  const code = userCode(requestId);

  const server = await listen();

  /*
  | ⚠ BUILT WITH `URL`, NOT BY GLUING STRINGS. The connect address may already
  | carry a question mark (another locale, another deployment, a test) — and a
  | glued `?request=` then makes a second question mark, which is a request the
  | far side cannot see while the tool waits five minutes.
  */
  const url = new URL(base);

  url.searchParams.set('request', requestId);
  url.searchParams.set('challenge', challenge);
  url.searchParams.set('state', state);
  url.searchParams.set('port', String(server.port));

  say('');
  say(`  Verification code:  ${code}`);
  say('');
  say('  Opening the browser. There: pick a store → check the code matches → Approve.');
  say(`  If it does not open by itself: ${url.href}`);
  say('');

  /*
  | ⚠ `--no-open` IS NOT ONLY FOR TESTS. A machine with no desktop — a server, a
  | container, an ssh session — has nothing to open, and the address is already
  | printed. The flag makes the silent behaviour explicit.
  */
  if (!args.includes('--no-open')) open(url.href);

  const back = await server.wait(state);

  if (back === null) {
    die('No approval arrived within 5 minutes. Run the command again.');
  }

  if (back.denied) {
    die('Refused on the approval screen. Nothing was written.');
  }

  /*
  | ⚠ `api` CAME THROUGH THE BROWSER, SO IT IS CHECKED BEFORE THE SECRET GOES
  | THERE (audit F2). A convincing fake dashboard can relay `state` to this port
  | and name its own server as `api`; the tool would then post `request_id` and
  | the verifier to it — and the fake page can even show the matching code. The
  | secret goes only to the platform, or, when `--connect` was typed by hand for
  | a local setup, to that same host.
  */
  if (!exchangeAllowed(back.api, args)) {
    die([`The approval pointed the key exchange at ${back.api || '(nothing)'}, which is not the platform.`,
      'Nothing was sent. If you did not start this login yourself, someone else did.'].join('\n   '));
  }

  say('  … approved, collecting the key');

  /*
  | ⚠ THE KEY IS ASKED FOR WITH THE SECRET, NOT WITH THE REQUEST ID. The id was
  | in the URL — so in the browser history and in the log of every proxy along
  | the way. The secret has never left this process.
  */
  const got = await exchange(back.api, requestId, verifier);

  if (got === null) {
    die('The approval was not accepted. It may have expired (two minutes) or already been collected.');
  }

  /*
  | ⚠ THE KEY GOES INTO A FILE, NOT INTO A MESSAGE ON SCREEN. Printed, it lands
  | in the terminal scrollback and in the shell history — two places it does not
  | leave. The file, meanwhile, goes into `.gitignore` right here.
  */
  fs.writeFileSync(TOKEN_FILE, got.token + '\n', { encoding: 'utf8', mode: 0o600 });

  const cfg = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : {};

  saveConfig({ ...cfg, api: back.api, store: got.store, version: cfg.version ?? '2026-07' });
  ignore([TOKEN_FILE, HOME + '/']);

  say('');
  say(`  ✓ Connected to ${back.api}`);
  say(`  ✓ The key is in ${TOKEN_FILE} (kept out of git)`);
  say('');
  say(`  Now: ${ME} pull`);
  say('');
}

/** May the secret travel to `api`? The platform, or the host `--connect` named. */
function exchangeAllowed(api, args) {
  let url;

  try { url = new URL(api); } catch { return false; }

  if (url.pathname.replace(/\/$/, '') !== '' || url.search || url.username || url.password) return false;
  if (isPlatform(api)) return true;

  const connect = flag(args, '--connect');

  if (connect === undefined) return false;

  let asked;

  try { asked = new URL(connect); } catch { return false; }

  // A hand-typed `--connect` is a local or staging setup: loopback (dashboard and
  // API on two `.test` hosts) or the very host that was typed, over HTTPS.
  return isLoopback(url.hostname)
    || (asked.hostname === url.hostname && url.protocol === 'https:');
}

/** The characters the approval screen computes too — derived from the id. */
function userCode(requestId) {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const digest = crypto.createHash('sha256').update('sellanto-cli-user-code:' + requestId, 'utf8').digest();

  let out = '';

  for (let at = 0; at < 8; at++) {
    out += alphabet[digest[at] % alphabet.length];

    if (at === 3) out += '-';
  }

  return out;
}

/**
 * The tiny server that waits for the browser.
 *
 * ⚠ ON `127.0.0.1` ONLY, not on `0.0.0.0`. The second would mean anyone on the
 * same network — a café, an office, an airport — could post an approval to this
 * port.
 *
 * ⚠ AND THE PORT IS RANDOM (0 = pick a free one). A fixed port would mean two
 * folders cannot connect at once, and that a stray page in the browser knows
 * where to knock.
 */
function listen() {
  return new Promise((resolve, reject) => {
    let settle = null;

    const server = http.createServer((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');

      if (url.pathname !== '/callback') {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });

        return response.end('no such address');
      }

      const out = {
        state: url.searchParams.get('state') ?? '',
        api: url.searchParams.get('api') ?? '',
        denied: url.searchParams.get('denied') === '1',
      };

      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page(out.denied));

      if (settle) settle(out);
    });

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,

        /*
        | ⚠ `state` IS CHECKED, NOT ACCEPTED. The port is open to everything on
        | this machine; a stray page in the browser can request
        | `http://127.0.0.1:<port>/callback?api=https://somewhere-else`. Without
        | the check the tool would go and ask that host for a key — and send it
        | its secret.
        */
        wait: (expected) => new Promise((done) => {
          const timer = setTimeout(() => { server.close(); done(null); }, 5 * 60 * 1000);

          settle = (out) => {
            if (out.state !== expected) return;

            clearTimeout(timer);
            server.close();
            done(out);
          };
        }),
      });
    });
  });
}

/** The page the person sees in the browser once they are back. */
function page(denied) {
  const title = denied ? 'Refused' : 'Done';
  const text = denied
    ? 'Nothing was connected. You can close this tab.'
    : 'The tool has the key. Go back to your terminal — you can close this tab.';

  return '<!doctype html><html lang="en"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${title} · Sellanto</title>`
    + '<body style="margin:0;display:grid;place-items:center;min-height:100vh;'
    + 'font:16px/1.5 system-ui,sans-serif;color:#111;background:#fff">'
    + '<main style="max-width:32rem;padding:1.5rem;text-align:center">'
    + `<h1 style="font-size:1.25rem;margin:0 0 .5rem">${title}</h1><p>${text}</p></main>`;
}

/** The secret for the key — over a second connection, in a body, not a URL. */
async function exchange(api, requestId, verifier) {
  const out = await call(
    { api, version: '2026-07', store: '_', anonymous: true },
    'POST',
    '/cli/token',
    { request_id: requestId, code_verifier: verifier },
  ).catch((e) => { say(`  ✗ ${e.message}`); return null; });

  if (out === null || typeof out.token !== 'string' || out.token === '') return null;

  return { token: out.token, store: String(out.store ?? '') };
}

/**
 * Opens the browser — and does NOT fail when there is none.
 *
 * The address is already printed above; a machine with no desktop (a server, a
 * container, an ssh session) has to be able to open it elsewhere. So there is
 * no success check here: this is a convenience, not a step.
 */
function open(url) {
  /*
  | ⚠ ON WINDOWS THE URL MUST BE QUOTED, AND THIS IS NOT BELT AND BRACES.
  |
  | `cmd.exe` treats `&` as a command separator. Our address carries four
  | parameters, so `cmd /c start "" https://…?request=A&challenge=B&…` reaches
  | the browser as `…?request=A` and cmd tries to RUN `challenge=B` as a
  | command. The person then lands on a screen saying the request is
  | incomplete — and nothing in the tool's own output looks wrong, because the
  | line it printed is correct. Measured, not guessed.
  |
  | Inside double quotes `&` loses its meaning, so the address arrives whole.
  | `windowsVerbatimArguments` is required: without it Node rebuilds the
  | command line and the quoting we just added is not what cmd sees.
  |
  | The empty `""` before it is the window title `start` expects — without it
  | `start` takes the quoted address AS the title and opens nothing.
  */
  const windows = process.platform === 'win32';

  const [command, args] = windows
    ? ['cmd', ['/c', 'start', '""', `"${url}"`]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];

  try {
    child.spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsVerbatimArguments: windows,
    }).unref();
  } catch { /* no browser: the address is printed */ }
}

/* ═══════════════════════════════════════════════════════════════════════════
   The commands
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Which store, when the person did not say.
 *
 * ⚠ THE ADDRESSES WANT `public_id` (a ULID), AND IT IS SHOWN NOWHERE IN THE
 * ADMIN (measured). Without this discovery the only way to start the CLI would
 * be for somebody to read the database — so a merchant could not start it alone.
 *
 * One store, take it. More than one, list them: uploading into the WRONG store
 * is visible to customers, so guessing here is not a convenience.
 */
async function discover(cfg) {
  const me = await call({ ...cfg, store: '_' }, 'GET', '/token?include=stores').catch(() => null);

  const stores = me?.stores;

  if (!Array.isArray(stores) || stores.length === 0) return null;
  if (stores.length === 1) return stores[0].id;

  say('  The key reaches more than one store — say which with --store:');
  for (const one of stores) say(`    ${one.id}  ${one.name}`);

  return null;
}

async function init(args) {
  const api = flag(args, '--api');
  const version = flag(args, '--version') ?? '2026-07';

  if (!api) die('I need --api <the store address>.');

  const theme = flag(args, '--theme');
  const store = flag(args, '--store') ?? await discover({ api, version });

  if (!store) {
    die('I could not work out the store. Add --store <public_id> from the list above.');
  }

  saveConfig(theme ? { api, store, version, theme } : { api, store, version });
  say(`  ✓ ${CONFIG}`);

  ignore([TOKEN_FILE, HOME + '/']);

  say(`\n  Now: ${ME} pull\n`);
}

/**
 * Switches which theme is being worked on.
 *
 * ⚠ WHY THIS EXISTS AT ALL. Until now the only way to change theme was to run
 * `init` again — which rewrites the whole settings file, including the
 * reference checksum and the last version check. A command whose name is
 * "initialise" is the wrong tool for "I want to look at another theme", and
 * people who are told to run it twice eventually run it with the wrong `--api`.
 *
 * ⚠ AND IT DOES NOT PULL. Switching the theme and downloading it are two
 * decisions: the folder may already hold uncommitted work on the previous one.
 */
async function use(cfg, args = []) {
  const wanted = args.find((one) => !one.startsWith('--'));

  if (!wanted) die(`I need the theme: ${ME} use <slug>   (see: ${ME} themes)`);

  const out = await call(cfg, 'GET', 'themes').catch(() => null);
  const known = (out?.themes ?? []).find((one) => one.theme === wanted);

  if (!known) {
    die([`This account may not edit \`${wanted}\`.`, `The ones it may: ${ME} themes`].join('\n   '));
  }

  if (known.ready !== true) {
    die(`\`${wanted}\` is listed but has no files yet — there is nothing to download.`);
  }

  /*
  | The reference belongs to the theme, so its checksum is dropped: keeping it
  | would mean the next `pull` decides "unchanged" and leaves the reference of
  | the PREVIOUS theme next to the new files.
  */
  const { referenceChecksum: _drop, ...rest } = cfg;

  saveConfig({ ...rest, theme: wanted });

  say(`  ✓ Now working on ${wanted}${known.active ? ' (the store runs it)' : ''}`);

  if (known.active !== true) {
    say('  ⚠ The storefront runs another theme, so `preview` will not show this work.');
  }

  say(`\n  Next: ${ME} pull\n`);
}

/** How many paths go into one batched request — matches `MAX_BATCH` on the server. */
const BATCH = 60;

/** How many BYTES of content are sent at once — matches `MAX_BATCH_BYTES`. */
const BATCH_BYTES = 4 * 1024 * 1024;

/**
 * Splits a list into batches — BY COUNT AND BY BYTES.
 *
 * ⚠ COUNT ALONE IS NOT ENOUGH. Sixty ordinary templates are a few hundred
 * kilobytes, but six large `theme.css` files are over the server's ceiling —
 * and then the whole batch is refused with `batch_too_large`. A client that
 * splits only by count makes a request it already knows will be refused.
 *
 * ⚠ The first row always goes in: a file larger than the batch still has to be
 * attempted — the server will say whether it is allowed.
 */
const batches = (list, size = BATCH) => {
  const out = [];
  let part = [];
  let bytes = 0;

  for (const one of list) {
    const length = typeof one?.content === 'string' ? Buffer.byteLength(one.content, 'utf8') : 0;

    if (part.length > 0 && (part.length >= size || bytes + length > BATCH_BYTES)) {
      out.push(part);
      part = [];
      bytes = 0;
    }

    part.push(one);
    bytes += length;
  }

  if (part.length > 0) out.push(part);

  return out;
};

/**
 * The theme as the store sees it — including the delivered files.
 *
 * ⚠ IN BATCHES, NOT FILE BY FILE. The ceiling is 40 requests per minute per
 * account and Aurora has 105 editable files — one file per request means the
 * channel's very first step cannot finish. Now it is two or three.
 */
async function pull(cfg) {
  const listing = await index(cfg);

  const wanted = [];
  let skipped = 0;

  for (const file of listing.files) {
    // A tombstone: locally this means "the file is not there".
    if (file.state === 'draft_removed') continue;

    /*
    | ⚠ THE PATH IS CHECKED BEFORE THE REQUEST. It comes out of the envelope, so
    | it is INPUT from outside — a mistyped address, a poisoned DNS answer or
    | someone in between could ask for a write outside the folder.
    */
    if (safeRelative(file.path) === null) {
      say(`  ✗ path from the server skipped: ${file.path}`);
      skipped++;

      continue;
    }

    wanted.push(file.path);
  }

  const tally = { created: 0, replaced: 0, same: 0 };
  const replaced = [];

  for (const part of batches(wanted)) {
    let rest = part;

    // The server's byte ceiling can return LESS than was asked for
    // (`truncated`) — then the remainder is asked for again, not lost.
    while (rest.length > 0) {
      const out = await remote(cfg, 'POST', 'files/read', { paths: rest });
      const got = Array.isArray(out.files) ? out.files : [];

      for (const file of got) {
        if (typeof file.content !== 'string') continue;

        const what = write(file.path, file.content);

        if (what === null) continue;

        tally[what]++;

        if (what === 'replaced') replaced.push(file.path);
      }

      const done = new Set(got.map((f) => f.path));

      rest = out.truncated ? rest.filter((path) => !done.has(path)) : [];

      // Without this, a server that says `truncated` while returning no files
      // at all would spin forever.
      if (out.truncated && got.length === 0) break;

      say(`  … ${tally.created + tally.replaced + tally.same}/${wanted.length}`);
    }
  }

  if (skipped > 0) say(`  (${skipped} skipped)`);

  /*
  | ⚠ AND THE REFERENCE, ALONGSIDE THE FILES. Someone who has just downloaded a
  | theme sits down to write Twig in a sandbox they know nothing about. A
  | reference that needs a separate command gets read after the first blank
  | screen, not before it.
  */
  await refreshReference(cfg);

  /*
  | ⚠ THE VERSION IS ASKED FOR, because the files listing does not carry it.
  |
  | One extra request on a command that already makes a dozen — and it answers
  | the question someone actually has after a pull: "which version of the theme
  | am I now holding". A failure here is not a failed pull: an older store
  | without the address must not turn a finished download into an error.
  */
  const known = await call(cfg, 'GET', 'themes').catch(() => null);
  const mine = (known?.themes ?? []).find((one) => one.theme === listing.theme);
  const label = mine?.version ? `${listing.theme} ${mine.version}` : listing.theme;

  /*
  | ⚠ THE THREE OUTCOMES, SEPARATELY. "176 files" was true before the pull and
  | after it, whatever happened in between — so it could not answer "did I get
  | anything". What answers it is how many files are NEW and how many CHANGED.
  */
  say(`\n  ${label} — ${tally.created} new, ${tally.replaced} updated, ${tally.same} unchanged`);

  /*
  | ⚠ AND WHICH FILES LOST WHAT THEY HELD. `pull` overwrites; before this, a
  | local edit that had not been pushed disappeared in silence and the line on
  | screen looked like success. It cannot be known whether those bytes were
  | your work or an older copy — so they are NAMED, and the judgement is left
  | to the person who wrote them.
  */
  if (replaced.length > 0) {
    say(`\n  ⚠ ${replaced.length} of them held something different here and it is gone:`);

    for (const route of replaced.slice(0, 10)) say(`      ${route}`);

    if (replaced.length > 10) say(`      … and ${replaced.length - 10} more`);

    say(`\n    Was that your work? It is in git, or nowhere — ${ME} pull does not keep a copy.`);
  }

  say(tally.created + tally.replaced === 0
    ? `\n  ✓ Nothing came down — ${process.cwd()} already matched the store.\n`
    : `\n  ✓ ${process.cwd()}. Write, then: ${ME} serve\n`);
}

/** What differs — without uploading anything. */
async function status(cfg, args = []) {
  const { changed, removed, listing } = await changes(cfg);

  /*
  | ⚠ AND THE STALE ONES, HERE, rather than behind a separate command nobody
  | will think to run. This is the only way someone with a folder on their own
  | computer learns that their copy came from a file the platform has changed.
  |
  | ⚠ AND IT DOES NOT STOP `status` when the address is missing: an older store
  | without it must not make the main command unusable.
  */
  const behind = await remote(cfg, 'GET', 'conflicts').catch(() => null);

  /*
  | ⚠ `--json` IS FOR AGENTS, NOT FOR PEOPLE. An assistant driving this tool
  | otherwise has to parse prose that changes with every wording fix — and it
  | parses it wrong silently. One stable shape costs a branch here and removes a
  | whole class of guesswork.
  */
  if (args.includes('--json')) {
    emit({
      store: storeLabel(cfg),
      store_id: cfg.store ?? null,
      theme: listing.theme,
      store_theme: cfg.storeTheme ?? null,
      changed: changed.map(([route, why]) => ({ path: route, state: why.trim() === 'new' ? 'new' : 'changed' })),
      removed,
      draft_files: listing.draft?.files ?? 0,
      stale: behind?.stale ?? null,
      tool_version: VERSION,
    });

    return;
  }

  /*
  | ⚠ WHICH STORE AND WHICH THEME — THE FIRST TWO LINES (01.10.2026).
  |
  | Until now `status` answered "what differs" without ever saying WHAT it
  | was comparing against. Someone with two folders, or one folder and two
  | stores, read a clean answer with no way to tell it was about the other
  | one — and that failure is silent: a clean `status` against the wrong
  | store looks exactly like a clean `status` against the right one.
  |
  | ⚠ THE HOST, NOT THE PUBLIC ID. `01M20ZP…` is what the API wants; the
  | address is what the person recognises. And it costs no request — it is
  | the `api` they are already pointed at.
  */
  say(`\n  Store: ${storeLabel(cfg)}`);

  say(cfg.storeTheme && cfg.storeTheme !== cfg.theme
    ? `  Theme: ${cfg.theme}  — preparing; the store renders ${cfg.storeTheme}`
    : `  Theme: ${cfg.theme}  — the store renders it`);

  say(`  Tool:  ${VERSION}`);

  say('');

  if (behind !== null && behind.stale > 0) {
    say(`  ⚠ ${files(behind.stale)} ${behind.stale === 1 ? 'is' : 'are'} behind the theme — see: conflicts`);
  }

  for (const route of removed) say(`  deleted  ${route}`);

  if (changed.length === 0 && removed.length === 0) {
    say(`  ✓ No differences. ${listing.draft.files === 0 ? 'The draft is empty.' : `${files(listing.draft.files)} waiting in the draft.`}`);

    return;
  }

  for (const [route, why] of changed) say(`  ${why}  ${route}`);

  if (changed.length === 0) return;

  say(`\n  ${files(changed.length)} to upload. Run: ${ME} push`);
}

/** Uploads the differences once. */
async function push(cfg, args = []) {
  const { changed, removed, local } = await changes(cfg);
  const alsoDelete = args.includes('--delete');

  /*
  | ⚠ DELETIONS ARE ALWAYS MENTIONED, not only when there is nothing else.
  |
  | Someone who deleted one section AND fixed another used to see only the
  | second — and walked away believing the deletion had gone through. It gets
  | discovered at `publish` at the earliest, which is in front of customers.
  */
  if (removed.length > 0 && !alsoDelete) {
    for (const route of removed) say(`  deleted  ${route}`);
    say(`  missing locally: ${files(removed.length)}. To remove them from the store too: push --delete`);
  }

  if (changed.length === 0 && (removed.length === 0 || !alsoDelete)) {
    if (removed.length === 0) say('  ✓ Nothing to upload.');

    return;
  }

  /*
  | ⚠ ONE WRITE FOR UP TO SIXTY FILES, NOT ONE EACH.
  |
  | Same reason as `pull`: the ceiling is 40 requests per minute. A first upload
  | of a ported theme is a hundred files; one per request means it cannot happen
  | without minutes of waiting.
  |
  | ⚠ AND DELETION RIDES THE SAME REQUEST (`content: null`), so ten deleted
  | files are not ten requests.
  */
  const payload = [
    ...changed.map(([route]) => ({ path: route, content: local.get(route) })),
    ...(alsoDelete ? removed.map((route) => ({ path: route, content: null })) : []),
  ];

  let ok = 0;
  let bad = 0;

  for (const part of batches(payload)) {
    const out = await remote(cfg, 'PUT', 'files', { files: part }).catch((e) => {
      say(`  ✗ ${e.message}`);

      return null;
    });

    if (out === null) { bad += part.length; continue; }

    for (const one of out.written ?? []) {
      say(one.state === 'draft_removed' ? `  − ${one.path}` : `  ↑ ${one.path}`);
      ok++;
    }

    /*
    | ⚠ THE REFUSAL CARRIES THE LINE, and that is the whole point of the
    | channel. "It did not work" over a two-hundred-line file helps nobody.
    */
    for (const one of out.refused ?? []) {
      const where = one.line ? ` (line ${one.line})` : '';
      const why = one.detail ? `: ${one.detail}` : '';

      say(`  ✗ ${one.path}${where} — ${one.reason}${why}`);
      bad++;
    }
  }

  /*
  | ⚠ A REFUSED FILE IS A FAILURE FOR THE EXIT CODE TOO.
  |
  | `sellanto push && sellanto publish` is the obvious line in a script. With
  | exit 0 over a refusal it publishes THE OLD DRAFT — so something the person
  | believes is fixed goes out to customers. The red line on screen is not read
  | by `&&`.
  */
  if (bad > 0) process.exitCode = 1;

  if (ok === 0) { say('\n  Not one file made it into the draft.'); process.exitCode = 1; return; }

  const url = (await remote(cfg, 'GET', 'preview')).preview_url;

  say(`\n  ✓ ${files(ok)} in the draft${bad > 0 ? `, ${bad} refused` : ''}. See it:\n    ${url}\n`);
}

/**
 * Uploads on every save.
 *
 * =========================================================================
 * ⚠ CHANGES ARE COLLECTED INTO ONE REQUEST, NOT ONE PER FILE
 * =========================================================================
 * One save from an editor is one file — but a `git checkout`, a formatter, or
 * rewriting a whole folder is hundreds of events in one second. One request per
 * file hits the ceiling of 40 per minute and the watcher falls asleep for
 * minutes — that is, exactly when the person is making their biggest change,
 * the channel stops.
 *
 * So events are collected in a short window and leave together. The window also
 * covers editors that write two or three times per save (temp file, rename,
 * touch).
 *
 * ⚠ AND ONE REQUEST AT A TIME. While an upload is in flight, new events pile up
 * for the NEXT one — otherwise two writes to one file can arrive out of order
 * and the draft keeps the EARLIER content.
 */
async function watch(cfg) {
  const url = (await remote(cfg, 'GET', 'preview')).preview_url;

  say(`  Preview: ${url}`);
  say('  Ctrl+C stops.\n');

  uploadOnSave(cfg);

  // Keeps the process alive without spinning the CPU.
  await new Promise(() => {});
}

/**
 * Every save goes into the draft — the half `watch` and `serve` share.
 *
 * ⚠ IT DOES NOT BLOCK AND IT PRINTS ITS OWN LINES. `serve` has a server to
 * bring up afterwards, so a function that never returns could not be reused;
 * and a silent watcher is worse than none, because the person cannot tell an
 * upload that failed from one that never fired.
 */
function uploadOnSave(cfg) {
  say(`  Watching ${DIRECTORIES.filter((d) => fs.existsSync(d)).join(', ')}`);

  const pending = new Set();
  let timer = null;
  let sending = false;

  const flush = async () => {
    if (sending || pending.size === 0) return;

    sending = true;

    const batch = [...pending];
    pending.clear();

    /*
    | ⚠ READING RACES THE EDITOR, AND THE EDITOR WINS.
    |
    | Between `existsSync` and `readFileSync` there is a window, and most
    | editors save with a temp file and a rename — so the file is gone exactly
    | when the person pressed Ctrl+S. That used to be an exception inside
    | `void flush()`, meaning THE WATCHER DIED while the person kept writing,
    | believing it was uploading.
    |
    | An unreadable file is SKIPPED rather than sent as a tombstone: the rename
    | arrives with its own event a moment later, while a deletion by mistake is
    | visible to customers.
    */
    const payload = [];

    for (const route of batch) {
      if (!fs.existsSync(route)) {
        // Gone locally means "give the delivered file back" — a tombstone.
        payload.push({ path: route, content: null });

        continue;
      }

      try {
        payload.push({ path: route, content: fs.readFileSync(route, 'utf8') });
      } catch (e) {
        say(`  … ${route} is being written right now (${e.code ?? e.message}) — waiting for the next save.`);
      }
    }

    if (payload.length === 0) {
      sending = false;

      return;
    }

    /*
    | ⚠ `sending` IS RELEASED EVEN ON A THROW. Stuck at `true`, the watcher
    | stays alive, keeps collecting events and uploads nothing more — silently,
    | while the person writes.
    */
    try {
      for (const part of batches(payload)) {
        const out = await remote(cfg, 'PUT', 'files', { files: part }).catch((e) => {
          say(`  ✗ ${e.message}`);

          return null;
        });

        if (out === null) continue;

        for (const one of out.written ?? []) {
          say(one.state === 'draft_removed' ? `  − ${one.path}` : `  ↑ ${one.path}`);
        }

        for (const one of out.refused ?? []) {
          const where = one.line ? ` (line ${one.line})` : '';
          const why = one.detail ? `: ${one.detail}` : '';

          say(`  ✗ ${one.path}${where} — ${one.reason}${why}`);
        }
      }
    } finally {
      sending = false;
    }

    // More may have piled up while that request was in flight.
    if (pending.size > 0) void flush();
  };

  for (const directory of DIRECTORIES) {
    if (!fs.existsSync(directory)) continue;

    fs.watch(directory, { recursive: true }, (_event, name) => {
      if (!name) return;

      const route = path.join(directory, name).split(path.sep).join('/');

      if (!EXTENSIONS.includes(path.extname(route).toLowerCase())) return;
      if (safeRelative(route) === null) return;

      pending.add(route);

      clearTimeout(timer);
      timer = setTimeout(() => void flush(), 150);
    });
  }
}

async function publish(cfg) {
  const done = await remote(cfg, 'POST', 'publish');

  // ⚠ NOT `path`: that is the name of the imported module, and shadowing it
  // waits for the first person who adds a line inside this loop.
  for (const one of done.paths ?? []) say(`  ▸ ${one}`);

  say(done.published === 0
    ? '  The draft is empty — nothing changed.'
    : `  ✓ ${files(done.published)} now live.`);
}

/**
 * The address where the draft can be seen — and the browser on it.
 *
 * ⚠ IT OPENS, like `login`. The address carries a signed key of a hundred-odd
 * characters, so "copy it out of the terminal" is a step people get wrong, and
 * the key lives an hour — a mistyped copy is noticed late. `--no-open` is the
 * same escape hatch as in `login`: a machine with no desktop has to be able to
 * take the printed line elsewhere.
 *
 * ⚠ THE LINE IS STILL PRINTED, AND ON ITS OWN. Terminals linkify a bare URL
 * only when it is whole; until 30.09.2026 the server handed out a broken one
 * (`…?store=slug/bg/?_sf_preview=…`), which is why it looked unclickable here.
 */
async function preview(cfg, args = []) {
  const running = await runningServe(cfg);

  if (running !== null) {
    say(`\n  ${running}\n  (serve is running: the local address, its key refreshes itself)\n`);

    if (!args.includes('--no-open')) open(running);

    return;
  }

  const out = await remote(cfg, 'GET', 'preview');

  say(`\n  ${out.preview_url}\n  (the key lives ${Math.round(out.expires_in / 60)} minutes)\n`);

  if (!args.includes('--no-open')) open(out.preview_url);
}

async function discard(cfg, args = []) {
  const only = flag(args, '--path');
  const out = await remote(cfg, 'DELETE', `draft${only ? `?path=${encodeURIComponent(only)}` : ''}`);

  say(`  ${out.discarded === 0 ? '✓ The draft was empty anyway.' : `✓ Discarded ${files(out.discarded)}. The live files were not touched.`}`);
}

/**
 * The line-by-line difference — LCS, without one dependency.
 *
 * ⚠ LINES, NOT CHARACTERS. A template is read by lines; a character diff over a
 * rewritten line is mush nothing can be seen in.
 *
 * The table is O(n·m) — for a file of a few thousand lines that is millions of
 * cells, i.e. instant and with no memory worth caring about. A large `theme.css`
 * is the only case where it would be felt, and it is cut off below.
 */
function unified(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');

  // A long file is not decomposed — only the line counts are reported.
  if (a.length * b.length > 4_000_000) {
    return [`  (large file: ${a.length} → ${b.length} lines; the difference is not decomposed)`];
  }

  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }

    if (table[i + 1][j] >= table[i][j + 1]) out.push(`  - ${a[i++]}`);
    else out.push(`  + ${b[j++]}`);
  }

  while (i < a.length) out.push(`  - ${a[i++]}`);
  while (j < b.length) out.push(`  + ${b[j++]}`);

  return out;
}

/**
 * What I changed against the DELIVERED theme.
 *
 * =========================================================================
 * TWO MODES, BECAUSE THERE ARE TWO QUESTIONS
 * =========================================================================
 * Without a path: "which files have I touched" — one list, not a byte of
 * content. With a path: "what exactly" — one request for one file.
 *
 * ⚠ Not "what changed since the last upload" — that is what `status` answers.
 *
 * ⚠ The first draft of this made a request FOR EVERY OWN FILE — so a merchant
 * with a hundred overridden files hit the ceiling of 40 per minute. Exactly the
 * defect `pull` and `push` no longer have, repeated in the third command
 * because it looked like "just one file".
 */
async function diff(cfg, args = []) {
  const only = args.find((one) => !one.startsWith('--'));
  const listing = await index(cfg);

  const mine = listing.files.filter((f) => f.state === 'live' || f.state === 'draft');

  if (only === undefined) {
    if (mine.length === 0) {
      say('  Not one own file — the theme is exactly as the platform delivers it.');

      return;
    }

    for (const one of mine) say(`  ${one.state === 'draft' ? 'draft' : 'live '}  ${one.path}`);

    say(`\n  ${files(mine.length)} ${mine.length === 1 ? 'is' : 'are'} yours. For the line-by-line difference: diff <path>\n`);

    return;
  }

  if (!mine.some((f) => f.path === only)) {
    say(`  "${only}" is not one of yours — the theme delivers it untouched.`);

    return;
  }

  const one = await remote(cfg, 'GET', `files/${encodeURI(only)}`);

  say(`\n  ── ${only}`);

  if (typeof one.delivered !== 'string') {
    say('  (a new file — the platform delivers no such thing)\n');

    return;
  }

  const lines = unified(one.delivered, one.content ?? '');

  say(lines.length === 0 ? '  (no difference)' : lines.join('\n'));
  say('');
}

/**
 * Which themes this store may touch.
 *
 * ⚠ PREPARATION WORKS FOR ANY OF THEM, PREVIEW ONLY FOR THE ACTIVE ONE. The
 * preview key is bound to the pair (store, theme) while the storefront renders
 * the store's own theme. It is said out loud, because otherwise someone
 * prepares a theme and wonders why `preview` does not show their work.
 *
 * ⚠ AND THE SHIPPED THEMES ARE IN THIS LIST. Every theme the platform offers
 * generally is downloadable and editable — that is what `ready` means. So the
 * way to start from a finished design is `use <slug>` and `pull`, not copying
 * files out of somebody's screenshot.
 */
async function themes(cfg, args = []) {
  const out = await call(cfg, 'GET', 'themes');

  if (args.includes('--json')) {
    emit({ active: out.active ?? null, themes: out.themes ?? [] });

    return;
  }

  say('');

  for (const one of out.themes ?? []) {
    const mark = one.active ? ' ◀ active' : '';
    const ready = one.ready ? '' : '   (not ready)';

    say(`    ${one.theme.padEnd(14)} ${String(one.version || '').padEnd(8)} ${one.name}${mark}${ready}`);
  }

  say(`\n  Work on another one: ${ME} use <slug>   then: ${ME} pull`);
  say('  Any ready theme above can be downloaded and edited; preview works only');
  say('  for the active one, and other themes are switched on from the admin.\n');
}

/** The versions of one file — newest first. */
async function versions(cfg, args = []) {
  const only = args.find((one) => !one.startsWith('--'));

  if (!only) die('I need the path: versions sections/hero.twig');

  const out = await remote(cfg, 'GET', `files/${encodeURI(only)}/versions`);

  if ((out.versions ?? []).length === 0) {
    say('  This file has no history — it has never been published through the channel.');

    return;
  }

  say(`\n  ${only}\n`);

  for (const one of out.versions) {
    // ⚠ An empty version is not "an empty file" but "back then nothing of mine
    // was here" — restoring to it is restoring TO THE THEME.
    say(`    ${String(one.no).padStart(3)}  ${one.created_at}${one.empty ? '   (the theme itself back then)' : ''}`);
  }

  say(`\n  To go back: ${ME} restore ${only} --version <number>\n`);
}

/**
 * Puts a file back to an older version — INTO THE DRAFT.
 *
 * ⚠ Without --version means TO THE THEME'S OWN FILE, not to the last version.
 * Those are two different sentences and the second one is said with a number.
 *
 * ⚠ AND IT IS NOT LIVE until you say `publish` — the channel has one promise.
 * With `--publish` the two moves become one, but it has to be asked for.
 */
async function restore(cfg, args = []) {
  const only = args.find((one) => !one.startsWith('--') && !/^\d+$/.test(one));

  if (!only) die('I need the path: restore sections/hero.twig [--version 3]');

  const asked = flag(args, '--version');
  const version = asked === undefined ? null : Number(asked);

  if (version !== null && !Number.isInteger(version)) die('--version wants a whole number.');

  const out = await remote(cfg, 'POST', `files/${encodeURI(only)}/restore`, { version });

  say(version === null
    ? `  ✓ ${only} → the theme's own file (in the draft)`
    : `  ✓ ${only} → version ${version} (in the draft)`);

  if (!args.includes('--publish')) {
    say(`\n  See it: ${out.preview_url}`);
    say(`  Then: ${ME} publish\n`);

    return;
  }

  /*
  | ⚠ `publish` RELEASES THE WHOLE DRAFT, not just the restored file.
  |
  | It reads as "put this one back and ship it", but if half-finished work is
  | waiting in the draft, that goes out to customers too. It is said BEFORE the
  | move, because the list AFTER it is already history.
  */
  say('  ⚠ `--publish` releases the whole draft, not just this file:');

  await publish(cfg);
}

/**
 * Which of my files are behind the theme.
 *
 * ⚠ AN OVERRIDDEN FILE IS A COPY AS OF THE MOMENT IT WAS COPIED. The theme goes
 * on living — a bug fix, a new drop, a new field — while the store keeps
 * rendering the copy. Someone working locally has no way to learn that except
 * from here.
 */
async function conflicts(cfg, args = []) {
  const out = await remote(cfg, 'GET', 'conflicts');
  const rows = out.files ?? [];

  if (args.includes('--json')) {
    emit({ theme: out.theme ?? null, stale: out.stale ?? 0, files: rows });

    return;
  }

  if (rows.length === 0) {
    say('  Not one own file — so nothing can be behind.');

    return;
  }

  for (const one of rows) {
    const label = { stale: 'BEHIND  ', unknown: 'unknown ', fresh: 'current ' }[one.state] ?? one.state;

    say(`  ${label}  ${one.path}`);
  }

  say(out.stale === 0
    ? '\n  ✓ Not one of them is behind the theme.'
    : `\n  ⚠ ${files(out.stale)} ${out.stale === 1 ? 'is a copy' : 'are copies'} of a file the platform has changed since.\n    Compare with the delivered one: ${ME} diff <path>`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   What `status`, `push` and `watch` share
   ═══════════════════════════════════════════════════════════════════════════ */

const index = (cfg) => remote(cfg, 'GET', 'files');

/**
 * Which store, said the way the merchant knows it — by host.
 *
 * A malformed `api` is not an error here: this line exists to orient
 * someone, and refusing to print it would hide the very setting that is
 * wrong.
 */
function storeLabel(cfg) {
  try {
    return new URL(cfg.api).host;
  } catch (e) {
    return String(cfg.api || '—');
  }
}

/**
 * What changed since the last upload — BY CHECKSUM, not by time.
 *
 * ⚠ A FILE'S TIMESTAMP SAYS NOTHING ABOUT ITS CONTENT. A `git checkout` of an
 * old branch makes every file "new", and so does an editor that saves without a
 * change. The checksum says exactly one thing and it is the true one.
 */
async function changes(cfg) {
  const listing = await index(cfg);
  const local = localFiles();
  const known = new Map(listing.files.map((f) => [f.path, f]));
  const changed = [];

  for (const [route, content] of local) {
    const file = known.get(route);

    if (!file) { changed.push([route, 'new']); continue; }
    if (file.hash !== sha256(content)) changed.push([route, 'chg']);
  }

  /*
  | ⚠ DELETED LOCALLY — ONLY MY OWN, NEVER THE DELIVERED ONES.
  |
  | `watch` sees the "file disappeared" event and sends a tombstone. `push` has
  | no events — it sees two snapshots. Without this branch, deleting worked ONLY
  | while the watcher was running: two different answers to one action.
  |
  | ⚠ AND NOT EVERYTHING THAT IS MISSING LOCALLY, WHICH IS THE IMPORTANT PART.
  | Someone who put ONE file in an empty folder and said `push` does NOT want to
  | delete their whole theme. So only files in state `live` or `draft` are
  | considered — the ones they overrode THEMSELVES. A missing `delivered` file
  | is the normal state of anyone who did not download the whole theme.
  */
  const removed = listing.files
    .filter((f) => (f.state === 'live' || f.state === 'draft') && !local.has(f.path))
    .map((f) => f.path);

  return { changed, removed, local, listing };
}

/**
 * The store's theme — asked once and remembered in `.sellanto.json`.
 *
 * ⚠ NOT PINNED BY HAND. A store that changed its theme has different files; a
 * pinned name would upload into a theme the storefront no longer renders — and
 * nobody would understand why the changes "do not show".
 */
let lastError = null;

async function theme(cfg) {
  const out = await call(cfg, 'GET', 'theme').catch((e) => { lastError = e; return null; });

  return out?.theme ?? null;
}

function flag(args, name) {
  const at = args.indexOf(name);

  return at === -1 ? undefined : args[at + 1];
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE REFERENCE, THE AGENT BRIEF, AND UPDATING THE TOOL ITSELF
   ═══════════════════════════════════════════════════════════════════════════ */

/** Where everything the tool keeps for itself lives. */
const HOME = '.sellanto';

const REFERENCE = `${HOME}/THEME-REFERENCE.md`;

/** The brief for coding assistants — at the root, where they look. */
const AGENTS = 'AGENTS.md';

/**
 * The reference as THE PLATFORM declares it — Markdown, to read beside the editor.
 *
 * ⚠ WRITTEN FROM THE RESPONSE, NOT CARRIED IN THIS FILE. A list of drops and
 * filters baked into the client drifts from the platform at its first release —
 * and silently, because the person reads the local file and believes it.
 */
function referenceMarkdown(ref) {
  const lines = [
    '# This store\'s theme — what it may use',
    '',
    '> ⚠ THIS FILE IS GENERATED. Do not edit it — the next `pull` or `docs`',
    '> overwrites it from the platform.',
    '',
    `Theme: **${ref.theme}** ${ref.theme_version ?? ''}`,
    `Contract checksum: \`${(ref.checksum ?? '').slice(0, 12)}\``,
    '',
    '## How to read this',
    '',
    'The theme is Twig in a **sandbox**: only what is listed here works. Nothing',
    'else exists for a template — including things that work in ordinary Twig',
    '(`|upper`, `|raw`, `source()`, `constant()`, `range`, `..`). That is not an',
    'oversight: each of them is either dangerous or redundant, and each one added',
    'is new surface.',
    '',
    '⚠ What is forbidden **does not fail on upload** — it fails on render. So a',
    'file with `|upper` passes validation and then does not draw the section. If',
    'something vanishes from the page with no error, look first for a name that',
    'is not in the lists below.',
    '',
    '## Tags',
    '',
    (ref.tags ?? []).map((one) => `\`{% ${one} %}\``).join(' · '),
    '',
    '## Filters',
    '',
    (ref.filters ?? []).map((one) => `\`|${one}\``).join(' · '),
    '',
    '## Functions',
    '',
    (ref.functions ?? []).map((one) => `\`${one}()\``).join(' · '),
    '',
    '## The data (drops)',
    '',
    'Fields outside these do not exist — referencing one draws an empty space,',
    'not an error.',
    '',
  ];

  for (const [root, ids] of Object.entries(ref.drops ?? {})) {
    lines.push(`### ${root}`, '', ids.map((one) => `\`${one}\``).join(' · '), '');
  }

  const paths = ref.paths ?? {};
  const limits = ref.limits ?? {};

  lines.push(
    '## Which files are editable',
    '',
    `Directories: ${(paths.directories ?? []).map((one) => `\`${one}/\``).join(' · ')}`,
    '',
    `Extensions: ${(paths.extensions ?? []).map((one) => `\`.${one}\``).join(' · ')}`,
    '',
    '⚠ Checkout is **not editable**, whatever the key is allowed to do:',
    (paths.read_only ?? []).map((one) => `\`${one}\``).join(' · '),
    '',
    'A broken home page is an inconvenience; a broken checkout is orders that do',
    'not happen, and it shows up only when somebody looks at revenue.',
    '',
    '## The limits',
    '',
    `- one file: up to **${Math.round((limits.max_bytes ?? 0) / 1024)} KB**`,
    `- own files per theme: up to **${limits.max_files ?? '?'}**`,
    `- path length: up to **${limits.max_path ?? '?'}** characters`,
    `- files in one batched request: up to **${limits.max_batch ?? '?'}**`,
    '',
  );

  return lines.join('\n');
}

/**
 * The brief for Claude Code, Cursor and the other coding assistants.
 *
 * =========================================================================
 * WHY A SEPARATE FILE, AND WHY AT THE ROOT
 * =========================================================================
 * `AGENTS.md` at the root of a working folder is what these tools read on their
 * own, without being told. `.sellanto/THEME-REFERENCE.md` is the full contract
 * and is long; an assistant needs something shorter and more imperative first —
 * what may be run, what may not be touched, and which mistake is silent.
 *
 * ⚠ THE SILENT MISTAKE IS THE WHOLE REASON THIS FILE EXISTS. An assistant
 * writes `|upper` because it works in every other Twig it has ever seen, the
 * upload succeeds, and the section simply stops rendering. Nothing in the
 * output says so. The brief says it before the first attempt.
 *
 * ⚠ IT IS GENERATED, LIKE THE REFERENCE — the limits and the directories come
 * from the platform's answer, not from constants in this file, so it cannot
 * quietly describe last year's rules.
 */
function agentsMarkdown(ref) {
  const paths = ref.paths ?? {};
  const limits = ref.limits ?? {};

  return [
    '# Working on this Sellanto theme',
    '',
    '> ⚠ GENERATED by `sellanto pull`. Do not edit — it is overwritten. Put your',
    '> own instructions in a different file.',
    '',
    `Theme **${ref.theme}** ${ref.theme_version ?? ''}. This folder is a working copy of one`,
    'store\'s theme. Files are uploaded through the `sellanto` CLI, never by',
    'copying them anywhere.',
    '',
    '## The rules that are not obvious',
    '',
    '1. **Templates are Twig in a sandbox.** Only the tags, filters, functions',
    '   and data listed in `.sellanto/THEME-REFERENCE.md` exist. Read that file',
    '   before writing a template.',
    '2. **A forbidden name fails at render, not at upload.** `|upper`, `|raw`,',
    '   `source()`, `constant()`, `range`, `..` and method calls on objects all',
    '   upload cleanly and then silently draw nothing. If a section disappears',
    '   with no error, look for a name that is not in the reference.',
    '3. **Uploading is not publishing.** `push` and `watch` write to a draft that',
    '   only `preview` shows. Customers see nothing until `publish`, which',
    '   releases the WHOLE draft at once.',
    '4. **Checkout is read-only**, whatever the key allows:',
    `   ${(paths.read_only ?? []).map((one) => `\`${one}\``).join(', ') || '—'}`,
    '5. **Binary files do not travel through this channel** (`.woff2`, `.png`).',
    '   They are uploaded as media from the admin. This folder is not a complete',
    '   copy of the theme.',
    '',
    '## Commands',
    '',
    '```bash',
    'sellanto status --json     # machine-readable: what differs, what is stale',
    'sellanto pull              # download the theme and refresh this file',
    'sellanto push              # upload changes into the draft',
    'sellanto preview           # the URL where the draft renders',
    'sellanto publish           # make the draft live',
    'sellanto diff <path>       # line by line against the delivered file',
    'sellanto conflicts --json  # which of our files the platform has since changed',
    'sellanto restore <path>    # put a file back to the theme\'s own version',
    '```',
    '',
    '⚠ `sellanto push` exits non-zero when a file is refused, so `push && publish`',
    'is safe to write. Refusals carry the line number.',
    '',
    '## Where to edit',
    '',
    `Directories: ${(paths.directories ?? []).map((one) => `\`${one}/\``).join(', ')}`,
    '',
    `Extensions: ${(paths.extensions ?? []).map((one) => `\`.${one}\``).join(', ')}`,
    '',
    '## Limits',
    '',
    `- one file up to ${Math.round((limits.max_bytes ?? 0) / 1024)} KB`,
    `- up to ${limits.max_files ?? '?'} own files per theme`,
    `- path up to ${limits.max_path ?? '?'} characters`,
    '- the API allows 40 requests per minute per account, which is why the CLI',
    '  batches; do not write loops that call it once per file',
    '',
    '## Do not',
    '',
    '- Do not read or commit `.sellanto.token` — it is a live API key.',
    '- Do not edit `.sellanto/THEME-REFERENCE.md` or this file; both are',
    '  regenerated.',
    '- Do not invent drops or filters "that ought to exist". If it is not in the',
    '  reference, it renders as nothing.',
    '',
  ].join('\n');
}

/**
 * Downloads the reference when the contract has shifted.
 *
 * ⚠ BY CHECKSUM, NOT BY RELEASE NUMBER. Releases happen often and almost never
 * change what is declared to themes; downloading on every deployment is a
 * request with no answer in it. The checksum changes EXACTLY when something
 * entered or left the contract.
 */
async function refreshReference(cfg, force = false) {
  const ref = await remote(cfg, 'GET', 'reference').catch(() => null);

  if (ref === null) return null;

  const same = cfg.referenceChecksum === ref.checksum && fs.existsSync(REFERENCE);

  if (same && !force && fs.existsSync(AGENTS)) return ref;

  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(REFERENCE, referenceMarkdown(ref) + '\n', 'utf8');
  fs.writeFileSync(AGENTS, agentsMarkdown(ref), 'utf8');

  cfg.referenceChecksum = ref.checksum;
  saveConfig(cfg);

  say(`  ✓ ${REFERENCE} · ${AGENTS}${same ? '' : ' (refreshed)'}`);

  return ref;
}

/** The reference, on request. */
async function docs(cfg) {
  const ref = await refreshReference(cfg, true);

  if (ref === null) {
    die('This store does not serve a reference — it is probably on an older release.');
  }

  say(`\n  Theme ${ref.theme} ${ref.theme_version ?? ''}.`);
  say(`  ${(ref.filters ?? []).length} filters · ${(ref.functions ?? []).length} functions · ${Object.keys(ref.drops ?? {}).length} data roots\n`);
}

/* ─────────────────────────── the tool itself ─────────────────────────── */

/**
 * Is there a newer version of the tool.
 *
 * ⚠ AT MOST ONCE A DAY, and that is the whole reason for `checkedAt`. A check
 * on every command is one request per keystroke against a ceiling of 40 per
 * minute — `watch` alone would spend it.
 *
 * ⚠ AND IT STOPS NOTHING IF IT FAILS. An older store without this address, a
 * dropped network or an expired key must not make `push` impossible: the
 * version check is a convenience, not part of the work.
 */
async function checkTool(cfg) {
  const day = 24 * 60 * 60 * 1000;

  if (cfg.checkedAt && Date.now() - cfg.checkedAt < day) return;

  const out = await call(cfg, 'GET', '/tools/theme-cli').catch(() => null);

  cfg.checkedAt = Date.now();
  saveConfig(cfg);

  if (out === null || out.version === VERSION) return;

  if (cfg.autoUpdate === true && isPlatform(cfg.api)) {
    say(`  … new version ${out.version} — updating (autoUpdate)`);
    await applyUpdate(cfg, out);

    return;
  }

  say(`  ⚠ There is a newer version of the tool: ${out.version} (yours is ${VERSION}).`);
  say(`    Update with: ${ME} selfupdate\n`);
}

/**
 * Overwrites ITSELF with what the platform serves.
 *
 * =========================================================================
 * ⚠ WHY THIS IS NOT AUTOMATIC BY DEFAULT
 * =========================================================================
 * Here code from the network becomes code on someone's machine. The chain that
 * turns this against them is short: one mistyped letter in `--api`, a poisoned
 * DNS answer, a proxy on a foreign network. So the platform SAYS and the person
 * DECIDES — unless they explicitly put `"autoUpdate": true` in `.sellanto.json`.
 * ⚠ `autoUpdate: true` TRUSTS THE STORE WITH CODE EXECUTION on this machine.
 *
 * Four fences, each stopping something different:
 *   0. **the platform host** — only `sellanto.com`, `*.sellanto.com` or `*.sellantoshop.dev` may
 *      serve an update; the checksum below cannot tell who sent it;
 *   1. **HTTPS** — required by `call()` for every host outside loopback;
 *      against eavesdropping and tampering on the network;
 *   2. **the checksum** — the downloaded bytes are checked against the `sha256`
 *      the platform declared, so a truncated or substituted answer is refused;
 *   3. **the shape** — it has to look like this tool at all, so an error page
 *      returned with 200 does not get written over the tool.
 */
async function applyUpdate(cfg, meta) {
  /*
  | ⚠ ONLY THE PLATFORM MAY REPLACE THE TOOL (audit F1). The checksum comes from
  | the same server as the bytes, so it proves integrity, not origin. A mistyped
  | `api`, a store's custom domain or a local fake could serve a matching pair —
  | and the replaced file runs with the developer's rights on the next command.
  */
  if (!isPlatform(cfg.api)) {
    say(`  ✗ ${cfg.api} is not the platform — the tool updates itself only from sellanto.com or *.sellantoshop.dev.`);
    say('    Install from the repository instead: npm i -g github:sellanto/cli\n');

    return false;
  }

  const source = await call(cfg, 'GET', '/tools/theme-cli/download', undefined, false, true)
    .catch((e) => { say(`  ✗ ${e.message}`); return null; });

  if (typeof source !== 'string' || source === '') {
    say('  ✗ The platform did not return the tool.');

    return false;
  }

  const got = crypto.createHash('sha256').update(source, 'utf8').digest('hex');

  if (meta.sha256 && got !== meta.sha256) {
    say(`  ✗ Checksum mismatch (${got.slice(0, 12)} instead of ${String(meta.sha256).slice(0, 12)}) — NOT writing.`);

    return false;
  }

  if (!source.startsWith('#!/usr/bin/env node') || !/^const VERSION = '/m.test(source)) {
    say('  ✗ What came back does not look like the tool — NOT writing.');

    return false;
  }

  /*
  | ⚠ THE REAL FILE, AND ITS EXECUTE BIT (01.10.2026).
  |
  | `npm i -g` makes `sellanto` a SYMLINK into the package. Renaming over the
  | link replaced the link itself with a plain 0644 file: the next command
  | answered `permission denied`, and the package behind it kept the old
  | version. So the target is resolved, and the new file gets the old one's mode.
  */
  let self = process.argv[1];
  let mode = 0o755;

  try {
    self = fs.realpathSync(self);
    mode = fs.statSync(self).mode & 0o777;
  } catch { /* keep the path as invoked */ }

  const temp = `${self}.new`;

  /*
  | ⚠ A GLOBAL INSTALL IS OFTEN NOT WRITABLE. `npm i -g` puts the file where an
  | ordinary user may not write. Without this catch the person sees EACCES and a
  | stack, so they cannot tell that their tool works — it just cannot replace
  | itself.
  */
  try {
    fs.writeFileSync(temp, source, { encoding: 'utf8', mode });
    fs.chmodSync(temp, mode | 0o111);
    fs.renameSync(temp, self);
  } catch (e) {
    try { fs.unlinkSync(temp); } catch { /* nothing to remove */ }

    say(`  ✗ Cannot write ${self} (${e.code ?? e.message}).`);
    say('    A global install is updated with: npm i -g github:sellanto/cli\n');

    return false;
  }

  say(`  ✓ Updated to ${meta.version}. Run the command again.`);

  return true;
}

async function selfupdate(cfg) {
  const out = await call(cfg, 'GET', '/tools/theme-cli');

  if (out.version === VERSION) {
    say(`  ✓ Already on ${VERSION} — there is nothing newer.`);

    return;
  }

  say(`  ${VERSION} → ${out.version} (${out.size} bytes)`);

  /*
  | ⚠ REFUSING TO WRITE IS A FAILURE FOR THE EXIT CODE TOO.
  |
  | A mismatched checksum, an unwritable folder, a truncated answer — all of it
  | is SAID on screen, but a screen is not read by cron or by CI. With exit 0 the
  | automation believes it updated — which is exactly what did not happen.
  */
  if (!await applyUpdate(cfg, out)) process.exitCode = 1;
}

/* ═══════════════════════════════════════════════════════════════════════════
   One local address to work against
   ═══════════════════════════════════════════════════════════════════════════ */

/** Which answers may be rewritten — text only; an image must arrive byte for byte. */
const REWRITABLE = /^(?:text\/|application\/(?:javascript|json|xml|manifest|ld\+json)|image\/svg)/i;

/** How long before the key expires a new one is fetched. */
const REFRESH_MARGIN_MS = 90 * 1000;

/**
 * A local address that keeps showing the draft — `serve`.
 *
 * =========================================================================
 * WHY A PROXY, AND NOT A LOCAL RENDERER
 * =========================================================================
 * The theme is Twig and the STOREFRONT renders it: the catalogue, the prices,
 * the cart and the customer all live there. A local renderer would be a second
 * implementation of the shop, and the day the two disagree is the day the
 * preview lies about what customers will get.
 *
 * So this is a pipe, not an engine. It forwards to the store, puts the signed
 * key on every request, and rewrites the store's address in the answer to the
 * local one — so links, forms and assets keep you HERE instead of throwing you
 * onto the public site halfway through a click.
 *
 * =========================================================================
 * ⚠ WHAT THIS BUYS OVER `preview`
 * =========================================================================
 * `preview` mints a key that lives an hour. The address in the bar then goes
 * stale, and the next reload silently shows the PUBLISHED page — exactly when
 * someone is checking their work, and with nothing on screen to say so. Here
 * the key is refreshed behind the scenes and never in the way, the address
 * never changes, and the browser keeps its tab, its scroll and its devtools.
 *
 * ⚠ ON `127.0.0.1` ONLY, never `0.0.0.0`. The pipe carries a key that shows
 * unpublished work; the second would hand it to everyone on the café wifi.
 *
 * ⚠ AND IT IS NOT A `.local` DOMAIN. A name like `shop.local` has to go in the
 * system hosts file, which needs administrator rights — a theme tool must not
 * ask for those. `127.0.0.1:<port>` needs nothing and reads the same.
 */
async function serve(cfg, args = []) {
  const asked = flag(args, '--port');
  const port = asked === undefined ? 8787 : Number(asked);

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    die('--port wants a whole number between 1024 and 65535.');
  }

  let key = await freshKey(cfg);

  const local = `http://127.0.0.1:${port}`;

  const server = http.createServer((request, response) => {
    // `preview` asks here whether this is still the pipe for ITS folder.
    if (request.url === SERVE_PROBE) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ store: cfg.store ?? null, theme: cfg.theme, url: local + key.path }));

      return;
    }

    void relay(cfg, request, response, () => key, (next) => { key = next; }, local);
  });

  server.on('error', (e) => die(e.code === 'EADDRINUSE'
    ? `Port ${port} is taken. Another one: ${ME} serve --port 8788`
    : e.message));

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  say(`\n  ${local}${key.path}`);
  say(`  The draft of ${cfg.theme}, from ${key.origin}`);

  /*
  | ⚠ A MARKER, SO `preview` OPENS THIS ADDRESS AND NOT THE STORE'S (30.09.2026).
  |
  | With `serve` running, `preview` used to open the one-hour key on the
  | store's own address — a second tab that goes stale while this one does
  | not. The marker says only where to ask; `preview` still asks the port
  | before believing it, so a marker left by a killed process costs nothing.
  */
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(SERVE_MARKER, JSON.stringify({ port, pid: process.pid }));

  process.on('exit', () => { try { fs.unlinkSync(SERVE_MARKER); } catch { /* already gone */ } });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

  /*
  | ⚠ IT UPLOADS ON SAVE TOO, AND THAT IS THE WHOLE POINT (01.10.2026).
  |
  | The first edition only piped. Measured with a real person: they edited a
  | section, reloaded the local address and saw nothing change — because the
  | edit was still on their disk. Nothing was broken; the tool simply answered
  | a question they were not asking.
  |
  | An address that looks like a dev server and does not upload is a trap: the
  | missing step is invisible, and the conclusion someone reaches is "the
  | preview is broken", not "I forgot a command". So `serve` is the whole loop
  | — save, upload, reload — and `watch` stays for a terminal without one.
  |
  | ⚠ `--no-watch` FOR THE CASE WHERE SOMEONE ELSE IS WATCHING. Two watchers
  | on one folder upload every save twice, against a ceiling of 40 requests a
  | minute.
  */
  if (!args.includes('--no-watch')) uploadOnSave(cfg);

  say('  The key refreshes itself. Ctrl+C stops.\n');

  if (!args.includes('--no-open')) open(local + key.path);

  // Keeps the process alive without spinning the CPU.
  await new Promise(() => {});
}

const SERVE_MARKER = `${HOME}/serve.json`;
const SERVE_PROBE = '/__sellanto/serve';

/**
 * The local address of a `serve` running for THIS folder, or null.
 *
 * ⚠ THE PORT IS ASKED, NOT THE FILE BELIEVED. A killed process leaves its
 * marker behind, and another program may have the port since; only a pipe
 * that answers for the same store and theme counts.
 */
async function runningServe(cfg) {
  let marker;

  try {
    marker = JSON.parse(fs.readFileSync(SERVE_MARKER, 'utf8'));
  } catch {
    return null;
  }

  const answer = await new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port: marker.port, path: SERVE_PROBE, timeout: 800 }, (response) => {
      let body = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(response.statusCode === 200 ? JSON.parse(body) : null); } catch { resolve(null); }
      });
    });

    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });

  if (answer === null) {
    try { fs.unlinkSync(SERVE_MARKER); } catch { /* already gone */ }

    return null;
  }

  return answer.theme === cfg.theme && answer.store === (cfg.store ?? null) ? answer.url : null;
}

/**
 * A preview key, and where it points.
 *
 * ⚠ THE PLATFORM DECIDES THE ADDRESS, not this file. `preview` already answers
 * "where is the draft seen"; a second construction here would be a second
 * answer, and the copy is always the one that drifts.
 */
async function freshKey(cfg) {
  const out = await remote(cfg, 'GET', 'preview');
  const url = new URL(out.preview_url);

  return {
    origin: url.origin,
    path: url.pathname,
    param: url.search.replace(/^\?/, ''),
    until: Date.now() + (Number(out.expires_in) || 0) * 1000,
  };
}

/**
 * One request, forwarded.
 *
 * ⚠ THE ANSWER IS ASKED FOR UNCOMPRESSED (`accept-encoding: identity`). The
 * address has to be rewritten inside the body, and rewriting gzip means
 * unpacking it first — work bought for nothing on a pipe used by one person on
 * one machine.
 */
async function relay(cfg, request, response, keyOf, keep, local) {
  let key = keyOf();

  /*
  | ⚠ REFRESHED BEFORE IT DIES, not after. A key that expires mid-session makes
  | the page fall back to PUBLISHED — without an error, without a redirect, and
  | without anything on screen to say the work is no longer what is shown.
  */
  if (Date.now() > key.until - REFRESH_MARGIN_MS) {
    key = await freshKey(cfg).catch(() => key);
    keep(key);
  }

  const upstreamOrigin = new URL(key.origin);
  const target = new URL(request.url, key.origin);

  target.protocol = upstreamOrigin.protocol;
  target.host = upstreamOrigin.host;

  // The key rides on EVERY request: links inside the page carry it, but a form
  // post, a fetch from the theme's script and a hand-typed path do not.
  for (const [name, value] of new URLSearchParams(key.param)) {
    if (!target.searchParams.has(name)) target.searchParams.set(name, value);
  }

  const headers = { ...request.headers, host: target.host, 'accept-encoding': 'identity' };

  // A 304 carries no body, and a body is what has to be rewritten.
  delete headers['if-none-match'];
  delete headers['if-modified-since'];

  const client = target.protocol === 'https:' ? https : http;

  const upstream = client.request(target, { method: request.method, headers }, (answer) => {
    const type = String(answer.headers['content-type'] ?? '');
    const out = { ...answer.headers };

    delete out['content-encoding'];
    delete out['content-length'];

    // A redirect to the store is a redirect out of the pipe.
    if (typeof out.location === 'string') out.location = out.location.split(key.origin).join(local);

    /*
    | ⚠ THE COOKIE HAS TO LOSE ITS HOME. `Domain=<store>` and `Secure` are both
    | refused by the browser on `http://127.0.0.1` — and a dropped cookie is an
    | empty cart and a checkout that forgets, which gets blamed on the theme.
    */
    if (out['set-cookie']) {
      out['set-cookie'] = [out['set-cookie']].flat().map((one) => one
        .replace(/;\s*Domain=[^;]*/ig, '')
        .replace(/;\s*Secure/ig, '')
        .replace(/;\s*SameSite=None/ig, '; SameSite=Lax'));
    }

    if (!REWRITABLE.test(type)) {
      response.writeHead(answer.statusCode ?? 200, out);
      answer.pipe(response);

      return;
    }

    const chunks = [];

    answer.on('data', (piece) => chunks.push(piece));
    answer.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8').split(key.origin).join(local);

      response.writeHead(answer.statusCode ?? 200, out);
      response.end(body);
    });
  });

  /*
  | ⚠ A BROKEN PIPE IS SAID, NOT SWALLOWED. Without this the server dies on the
  | first dropped connection, and the person keeps saving against an address
  | that stopped answering.
  */
  upstream.on('error', (e) => {
    say(`  ✗ ${request.method} ${request.url} — ${e.message}`);

    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });

    response.end('The store did not answer: ' + e.message);
  });

  request.pipe(upstream);
}

/* ═══════════════════════════════════════════════════════════════════════════
   The door
   ═══════════════════════════════════════════════════════════════════════════ */

const HELP = `
  Your store's theme, locally.

  Invoked as «${ME}»:

    login [--no-open]        get a key through the browser (start here)
    init --api <url> [--store <public_id>] [--theme <slug>]
    themes [--json]          which themes this store may edit
    use <slug>               work on another theme
    pull                     download the theme here
    status [--json]          what differs
    push [--delete]          upload the differences into the draft
    watch                    the same, on every save
    preview [--no-open]      the URL where it can be seen (the local one while serve runs)
    serve [--port N]         one local address: serves the draft AND uploads on save
    publish                  the draft becomes live
    discard [--path <path>]  throw the draft away

    diff [<path>]            what I changed against the delivered theme
    conflicts [--json]       which of my files are behind the theme
    versions <path>          the history of one file
    restore <path> [--version N] [--publish]
                             put a file back (without --version: to the theme)

    docs                     rewrite .sellanto/THEME-REFERENCE.md and AGENTS.md
    selfupdate               update the tool itself

  Without --store it works itself out, if the key reaches exactly one store.
  "push" without --delete removes NOTHING — it only reports what is missing.

  "login" writes the key itself; "init" is for a key you already have.
  The key lives in SELLANTO_TOKEN or in ${TOKEN_FILE}. This tool is ${VERSION}.
  Full instructions: github.com/sellanto/cli (and /dev/docs, the CLI section).
`;

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help') { say(HELP); return; }

  /*
  | ⚠ TWO COMMANDS COME BEFORE THE SETTINGS. `config()` exits with a sentence
  | when `.sellanto.json` is missing — and these two are what CREATE it. Placed
  | below, they would demand the file they exist to write.
  */
  if (command === 'login') { await login(args); return; }
  if (command === 'init') { await init(args); return; }

  const cfg = config();

  /*
  | ⚠ THE THEME IS RESOLVED BEFORE EVERY COMMAND, NOT READ FROM THE FILE.
  |
  | The slug in `.sellanto.json` is only what was remembered last time. A store
  | that changed its theme from the admin has to be followed — otherwise every
  | upload goes into a theme the storefront does not render, and says nothing.
  */
  const slug = await theme(cfg);

  if (!slug) {
    die(['I cannot work out the store\'s theme.', (lastError?.message ?? ''), 'The key needs the write_theme_code scope ("Write · Theme code"), the themes.edit_code permission, and a plan with the code editor.'].join('\n   '));
  }

  /*
  | ⚠ A CHOSEN THEME IS NOT OVERWRITTEN BY THE ACTIVE ONE.
  |
  | The channel accepts any theme the account is entitled to — so someone
  | PREPARING `kometa` while the store renders `aurora` must not be silently
  | moved back. The difference is SAID once, because it is also the reason
  | `preview` does not show that work.
  */
  if (cfg.theme !== undefined && cfg.theme !== slug) {
    say(`  ℹ You are preparing ${cfg.theme}; the store renders ${slug}. Preview shows ${slug}.`);
  } else if (cfg.theme !== slug) {
    cfg.theme = slug;
    saveConfig(cfg);

    say(`  The store's theme is ${slug}.`);
  }

  /*
  | ⚠ AFTER THE SAVES, AND NOT PART OF THE SETTINGS FILE. Which theme the
  | storefront renders is a fact about the store TODAY, asked on every run;
  | written to disk it would be a second, staler copy of the answer.
  */
  cfg.storeTheme = slug;

  /*
  | ⚠ THE VERSION CHECK COMES BEFORE THE COMMAND, but does NOT stop it.
  |
  | An old client against a new API sees "it did not work" instead of a
  | sentence, so its version is part of compatibility. But a check that stops
  | the work when the network drops is worse than an old client.
  */
  if (command !== 'selfupdate') await checkTool(cfg);

  const commands = { pull, status, push, watch, preview, serve, publish, discard, diff, versions, restore, conflicts, docs, selfupdate, themes, use };

  if (!commands[command]) die(`No such command \`${command}\`.${HELP}`);

  await commands[command](cfg, args);
}

main().catch((error) => die(error.message));
