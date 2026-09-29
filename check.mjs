#!/usr/bin/env node
// Checks what this REPOSITORY promises, not what the tool does.
//
// The tool's behaviour is tested in the Sellanto monorepo, against a real API.
// What is guarded here is different: that the two versions in this folder have
// not drifted apart, and that the `sellanto` command starts at all. Both break
// silently.
//
//   npm test

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const CLIENT = 'sellanto-theme.mjs';

let failed = 0;

const check = (name, fn) => {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    failed++;
  }
};

const eq = (got, want, what) => {
  if (got !== want) throw new Error(`${what}: ${got} instead of ${want}`);
};

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const source = fs.readFileSync(CLIENT, 'utf8');

console.log('\n  Checking the package\n');

/*
| ⚠ THE TWO VERSIONS ARE ONE VERSION, WRITTEN DOWN TWICE.
|
| The real one is in the script: the platform reads it from there and
| `selfupdate` compares AGAINST IT. package.json needs semver while the format
| is a date, hence the mapping:
|
|     2026-09-29.3  ->  2026.929.3
|     year . MMDD . fix-on-the-same-day
|
| Let them drift and `npm i -g` installs one version while the tool claims
| another — and `selfupdate` stays quiet, because it compares its own.
*/
check('the version can be read out of the script', () => {
  if (!/^const VERSION = '([^']+)';/m.test(source)) {
    throw new Error('the `const VERSION = ...` line is missing or indented');
  }
});

check('package.json and the script state one version', () => {
  const own = source.match(/^const VERSION = '([^']+)';/m)[1];
  const m = own.match(/^(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?$/);

  if (!m) throw new Error(`the version in the script is not a date: ${own}`);

  eq(pkg.version, `${m[1]}.${Number(m[2])}${m[3]}.${m[4] ?? 0}`, `${own} means`);
});

check('the shebang is there', () => {
  if (!source.startsWith('#!/usr/bin/env node')) throw new Error('missing #!/usr/bin/env node');
});

check('no dependencies', () => {
  eq(Object.keys(pkg.dependencies ?? {}).length, 0, 'dependencies');

  const bad = [...source.matchAll(/^import .* from '([^']+)';/gm)]
    .map((one) => one[1])
    .filter((one) => !one.startsWith('node:'));

  eq(bad.join(', '), '', 'foreign modules imported');
});

check('the command is called sellanto and points at the client', () => {
  eq(pkg.bin?.sellanto, CLIENT, 'bin.sellanto');

  if (!pkg.files?.includes(CLIENT)) throw new Error(`${CLIENT} is not in "files"`);
});

check('the tool starts and prints its help', () => {
  const out = execFileSync(process.execPath, [CLIENT, '--help'], { encoding: 'utf8' });

  if (!out.includes('login') || !out.includes('publish')) {
    throw new Error('the help does not list the commands');
  }
});

check('the help names itself the way it was invoked', () => {
  const out = execFileSync(process.execPath, [CLIENT, '--help'], { encoding: 'utf8' });

  if (!out.includes(`node ${CLIENT}`)) {
    throw new Error('invoked through node, and does not say so');
  }
});

/*
| ⚠ THE TOOL IS PUBLIC AND ITS AUDIENCE IS NOT BULGARIAN.
|
| The rest of Sellanto is written in Bulgarian. This file is handed to whoever
| the merchant hires, and it is read on GitHub — so one stray sentence in
| Cyrillic is a sentence somebody cannot act on. Cheap to check, invisible to
| forget.
*/
check('no Cyrillic is left in the client', () => {
  const lines = source.split('\n').filter((one) => /[Ѐ-ӿ]/.test(one));

  eq(lines.length, 0, `lines with Cyrillic (first: ${lines[0]?.trim().slice(0, 60) ?? '—'})`);
});

console.log(failed === 0 ? '\n  All good.\n' : `\n  Failed: ${failed}\n`);

process.exit(failed === 0 ? 0 : 1);
