#!/usr/bin/env node
// Проверява това, което репото ОБЕЩАВА, а не това, което инструментът прави.
//
// Работата на инструмента се проверява в монорепото на Sellanto, срещу истинско
// API. Тук се пази друго: че двете версии в тази папка не са се разминали и че
// командата `sellanto` изобщо тръгва. И двете се чупят тихо.
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
  if (got !== want) throw new Error(`${what}: ${got} вместо ${want}`);
};

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const source = fs.readFileSync(CLIENT, 'utf8');

console.log('\n  Проверка на пакета\n');

/*
| ⚠ ДВЕТЕ ВЕРСИИ СА ЕДНА, ЗАПИСАНА ДВА ПЪТИ.
|
| Истинската е в скрипта: платформата я чете оттам и `selfupdate` сравнява
| СРЕЩУ НЕЯ. package.json иска semver, а форматът е дата, затова:
|
|     2026-09-29.2  ->  2026.929.2
|     година . ММДД . поправка в същия ден
|
| Разминат ли се, `npm i -g` слага друга версия от онази, която инструментът
| после твърди, че е — и `selfupdate` мълчи, защото сравнява своята.
*/
check('версията в скрипта се чете', () => {
  if (!/^const VERSION = '([^']+)';/m.test(source)) {
    throw new Error('редът `const VERSION = ...` го няма или е с отстъп');
  }
});

check('package.json и скриптът казват една версия', () => {
  const own = source.match(/^const VERSION = '([^']+)';/m)[1];
  const m = own.match(/^(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?$/);

  if (!m) throw new Error(`версията в скрипта не е дата: ${own}`);

  eq(pkg.version, `${m[1]}.${Number(m[2])}${m[3]}.${m[4] ?? 0}`, `${own} значи`);
});

check('решетката отгоре я има', () => {
  if (!source.startsWith('#!/usr/bin/env node')) throw new Error('липсва #!/usr/bin/env node');
});

check('нула зависимости', () => {
  eq(Object.keys(pkg.dependencies ?? {}).length, 0, 'зависимости');

  const bad = [...source.matchAll(/^import .* from '([^']+)';/gm)]
    .map((one) => one[1])
    .filter((one) => !one.startsWith('node:'));

  eq(bad.join(', '), '', 'внесени чужди модули');
});

check('командата се казва sellanto и сочи към клиента', () => {
  eq(pkg.bin?.sellanto, CLIENT, 'bin.sellanto');

  if (!pkg.files?.includes(CLIENT)) throw new Error(`${CLIENT} не е в "files"`);
});

check('инструментът тръгва и показва помощта', () => {
  const out = execFileSync(process.execPath, [CLIENT, '--help'], { encoding: 'utf8' });

  if (!out.includes('init') || !out.includes('publish')) {
    throw new Error('помощта не изброява командите');
  }
});

check('помощта се нарича с името, с което е повикана', () => {
  const out = execFileSync(process.execPath, [CLIENT, '--help'], { encoding: 'utf8' });

  if (!out.includes(`node ${CLIENT}`)) {
    throw new Error('повикан през node, а не го казва');
  }
});

console.log(failed === 0 ? '\n  Всичко е наред.\n' : `\n  Паднали: ${failed}\n`);

process.exit(failed === 0 ? 0 : 1);
