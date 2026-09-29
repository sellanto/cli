#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ТЕМАТА НА МАГАЗИНА, НА СОБСТВЕНИЯ ТИ КОМПЮТЪР (Р14-1)
// ═══════════════════════════════════════════════════════════════════════════
//
// ЗА КОГО Е ТОЗИ ФАЙЛ
// ───────────────────
// За СОБСТВЕНИКА НА МАГАЗИН, не за платформата. `scripts/temi.mjs` е съседният
// файл и прави друго: той строи темите НА Sellanto, в монорепото, и завършва с
// разгръщане. Този тук не пипа нито репото, нито сървъра — той говори с
// публичното API на един магазин и качва файловете на ЕГО тема.
//
// Единственият начин да стигнеш до тези файлове досега беше текстово поле в
// админа, по един файл. Тоест човек със свой редактор, свой git и око върху
// целия файл нямаше как да работи. Оттук има.
//
// ⚠ КАЧЕНОТО НЕ Е ЖИВО. `push` и `watch` пишат в ЧЕРНОВА: витрината я показва
// само на адреса с подписания ключ, който `preview` отпечатва. Клиентите на
// магазина виждат старото, докато не кажеш `publish`. Това е нарочно — при
// `watch` всяко натискане на Ctrl+S е заявка, включително върху полуписан
// шаблон, а такова нещо не бива да стига до жив магазин.
//
// КАК СЕ ПОДКАРВА
// ───────────────
//   1. В админа: Настройки → API ключове → нов ключ с обхват `write_theme_code`
//      („Запис · Код на темата"). ⚠ НЕ `write_content`: той е за блога и от
//      Р14-1 насам НЕ дава право върху кода на темата, включително за заварени
//      ключове — правата се смятат на всяка заявка, а не се пазят в реда.
//      (Иска още право `themes.edit_code` и план, който има редактора на код.)
//   2. Слагаш го като команда `sellanto` (или го викаш с `node` — работи и без):
//
//        npm i -g github:sellanto/cli
//
//      ⚠ Инсталацията е от ХРАНИЛИЩЕТО, не от npm регистъра. Регистърът е още
//      едно място, от което може да дойде различен файл; `selfupdate` пък тегли
//      от САМИЯ МАГАЗИН, тоест командата се лекува сама срещу вярното API.
//
//   3. В папката, в която искаш темата:
//
//        export SELLANTO_TOKEN="ключът"          # или го сложи в .sellanto.token
//        sellanto init --api https://<магазинът> --store <public_id>
//        sellanto pull
//
//   4. Пишеш с каквото пишеш. После:
//
//        sellanto watch            # качва при всяко запазване
//        sellanto preview          # адресът, на който се вижда
//        sellanto publish          # чак сега го виждат клиентите
//
// КОМАНДИТЕ
// ─────────
//   init      Записва `.sellanto.json` (адрес, магазин, версия на API-то).
//   pull      Сваля темата в текущата папка — доставените файлове също.
//   status    Какво се различава: локално, живо, в чернова.
//   push      Качва разликите в черновата (веднъж).
//   watch     Същото, но при всяко запазване на файл.
//   preview   Пресен адрес за преглед на черновата (ключът живее час).
//   publish   Черновата става жива — всички файлове наведнъж.
//   discard   Изхвърля черновата. Живото не се пипа.
//
// И четирите, които трябват, когато нещо е се счупило:
//
//   diff      Какво съм сменил спрямо ДОСТАВЕНАТА тема, ред по ред.
//   conflicts Кои мои файла са копия на файл, който платформата е сменила
//             оттогава. Без това работещият локално няма откъде да го научи.
//   versions  Историята на един файл — всяко публикуване оставя следа.
//   restore   Връща файл назад. ⚠ В ЧЕРНОВАТА — каналът има едно
//             обещание и връщането НЕ е изключение. С `--publish` двата
//             хода стават един, но се иска изрично.
//
// ⚠ БЕЗ НИТО ЕДНА ЗАВИСИМОСТ. Този файл се дава на търговец, който не иска да
//   разбира какво е `npm install` — затова само вградени модули на Node.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

/**
 * ВЕРСИЯТА НА ИНСТРУМЕНТА — един източник.
 *
 * ⚠ РЕДЪТ СЕ ЧЕТЕ И ОТ ПЛАТФОРМАТА (`ThemeCliController::versionOf()`),
 * за да не съществува второ място с версията. Форматът му е договор:
 * `const VERSION = '…';` на свой ред, без отстъп.
 *
 * Стойността е дата, с `.N` при втора поправка в същия ден: `selfupdate`
 * сравнява НИЗОВЕ, тоест непроменена версия върху променен файл значи
 * „вече си на най-новото" пред човек, който държи стария текст.
 */
const VERSION = '2026-09-29.3';

const CONFIG = '.sellanto.json';
const TOKEN_FILE = '.sellanto.token';

// Папките, които API-то изобщо признава (`ThemeCustomizations::DIRECTORIES`).
// Тукашното копие е за ОБХОДА НА ДИСКА, а не второ правило: правилото е на
// сървъра и отказва с име. Тук то само пази `watch` да не гледа `node_modules`.
const DIRECTORIES = [
  'layouts', 'templates', 'sections', 'snippets',
  'blocks', 'assets', 'locales', 'config',
];

const EXTENSIONS = ['.twig', '.json', '.css', '.js', '.txt', '.md'];

/* ═══════════════════════════════════════════════════════════════════════════
   Дребните
   ═══════════════════════════════════════════════════════════════════════════ */

const say = (...a) => console.log(...a);
const die = (m) => { console.error('\n  ✗ ' + m + '\n'); process.exit(1); };

/**
 * КАК Е ПОВИКАН ИНСТРУМЕНТЪТ — за да го пише в съветите със същите думи.
 *
 * Три форми стигат дотук и трите са редовни: `sellanto` (сложен на PATH),
 * `./sellanto-theme.mjs` (изпълнимият бит и решетката отгоре) и
 * `node sellanto-theme.mjs`. Съвет, който казва третото на човек, написал
 * първото, е съвет, който не се копира — а точно за копиране е.
 *
 * ⚠ При глобална инсталация argv[1] е файлът В `node_modules`, не името на
 * обвивката, която npm е сложил на PATH. Затова се пита за папката, а не се
 * гледа само името.
 */
const ME = (() => {
  const self = process.argv[1] ?? '';

  if (self.split(path.sep).join('/').includes('/node_modules/')) return 'sellanto';

  const base = path.basename(self);

  if (base === '') return 'sellanto';

  return /\.(mjs|cjs|js)$/.test(base) ? `node ${base}` : base;
})();

/** Един файл или много — „1 файла“ не е изречение на български. */
const files = (n) => (n === 1 ? '1 файл' : `${n} файла`);

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * Записва настройката.
 *
 * ⚠ Един писач, защото тук влизат и научени неща (темата, отпечатъкът
 * на справката, кога е проверена версията) — три мяста, които пишат файла,
 * са три повода едно от тях да изтрие чуждото поле.
 */
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

function config() {
  if (!fs.existsSync(CONFIG)) {
    die(`Няма ${CONFIG}. Пусни първо:\n     ${ME} init --api <адрес> --store <public_id>`);
  }

  const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

  if (!raw.api || !raw.store) die(`${CONFIG} е без \`api\` или \`store\`.`);

  return { version: '2026-07', ...raw };
}

/**
 * Ключът — от средата или от файл, НИКОГА от `.sellanto.json`.
 *
 * ⚠ Разделени са нарочно: `.sellanto.json` описва КЪДЕ се качва и влиза в git;
 * ключът е тайна и не бива да го последва там. Затова `init` записва и ред в
 * `.gitignore`.
 */
function token() {
  const fromEnv = process.env.SELLANTO_TOKEN;
  if (fromEnv) return fromEnv.trim();

  if (fs.existsSync(TOKEN_FILE)) return fs.readFileSync(TOKEN_FILE, 'utf8').trim();

  die(`Няма ключ. Сложи го в средата:\n     export SELLANTO_TOKEN="…"\n   или във файл ${TOKEN_FILE} (той не влиза в git).`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   API
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Едно повикване. Връща разбрания отговор или пада с ИЗРЕЧЕНИЕТО на отказа.
 *
 * ⚠ ОТКАЗЪТ СЕ ЧЕТЕ, А НЕ СЕ СВЕЖДА ДО СТАТУС. Пликът на API-то носи `code`,
 * `message`, а при невалиден файл и `line` — тоест „ред 42: неочакван endfor“
 * може да се отпечата до пътя. „HTTP 422“ би пратило човека да чете логове.
 */
/**
 * @param raw връща ТЕКСТА, а не разбран плик — само за самия инструмент,
 *            който е скрипт, а не JSON.
 */
function call(cfg, method, route, body, retried = false, raw = false) {
  /*
  | Маршрут с водеща `/` е ИЗВЪН `stores/{id}/` — единственият такъв днес е
  | `token`, от който се открива магазинът.
  |
  | ⚠ А НЕ `../token`: `new URL` нормализира пътя и броенето на точките
  | става тиха загадка — едно ниво повече и заявката тръгва към
  | `stores/token`, което е 404 без причина.
  */
  const base = `${cfg.api.replace(/\/$/, '')}/api/${cfg.version}`;
  const url = new URL(route.startsWith('/')
    ? `${base}${route}`
    : `${base}/stores/${cfg.store}/${route}`);

  /*
  | ⚠ БЕЗ HTTPS КЪМ ЧУЖД ХОСТ. Заглавието `Authorization` носи ключ с
  | право да пише код на витрината. При `watch` то тръгва ПРИ ВСЯКО
  | ЗАПАЗВАНЕ — тоест едно сгрешено `--api http://…` е стотици показвания
  | на ключа в чист вид, без никой да е предупреден.
  |
  | Лоопбекът е изключение, защото там няма мрежа, в която да се подслушва
  | — и без него работата срещу свой `artisan serve` би била невъзможна.
  */
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
    || url.hostname.endsWith('.localhost')
    || url.hostname.endsWith('.test');

  if (url.protocol !== 'https:' && !local) {
    die([`Ключът не тръгва по ${url.protocol} към ${url.hostname}.`, 'Смени `api` в .sellanto.json на https://'].join('\n   '));
  }

  const client = url.protocol === 'http:' ? http : https;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');

  return new Promise((resolve, reject) => {
    const request = client.request(url, {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* пликът може да е празен */ }

        if (response.statusCode >= 200 && response.statusCode < 300) {
          return resolve(raw ? text : (parsed?.data ?? parsed));
        }

        /*
        | ⚠ 429 НЕ Е ГРЕШКА, А ТЕМПО — И НЕ Е В ОБИЧАЙНИЯ ПЛИК.
        |
        | Таванът по подразбиране е 40 заявки в минута НА АКАУНТ
        | (`storefront.api.rpm_fallback`), а една тема има стотица файла — тоест
        | първият `pull` ГАРАНТИРАНО удря тавана. Без този клон свалянето
        | на тема просто пропуска две трети от файловете с червени редове.
        |
        | Отказът носи `retry_after` в КОРЕНА на тялото (друга форма от
        | плика на ресурсните откази) и заглавие `Retry-After`. Изчаква се
        | точно толкова и се опитва пак — веднъж, не вечно: второ 429 след
        | изчакване значи чужд клиент на същия акаунт, а не наше темпо.
        */
        if (response.statusCode === 429 && !retried) {
          const wait = Number(response.headers['retry-after'] ?? parsed?.retry_after ?? 5);

          say(`  … таванът на заявките е ударен, изчаквам ${wait}s`);

          return void setTimeout(
            () => call(cfg, method, route, body, true).then(resolve, reject),
            (Number.isFinite(wait) && wait > 0 ? wait : 5) * 1000,
          );
        }

        const error = parsed?.errors?.[0] ?? (parsed?.code ? parsed : null);
        const where = error?.line ? ` (ред ${error.line})` : '';
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

const remote = (cfg, method, suffix, body) =>
  call(cfg, method, `themes/${cfg.theme}/${suffix}`, body);

/* ═══════════════════════════════════════════════════════════════════════════
   Дискът
   ═══════════════════════════════════════════════════════════════════════════ */

/** Всички файлове на темата в текущата папка — път → съдържание. */
function localFiles() {
  const found = new Map();

  for (const directory of DIRECTORIES) {
    if (!fs.existsSync(directory)) continue;

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) { walk(full); continue; }

        /*
        | ⚠ САМО ИСТИНСКИ ФАЙЛОВЕ. Symlink не е нито папка, нито отсеян
        | от разширението — тоест тема, взета от трета страна с
        | `sections/logo.json -> ~/.aws/credentials`, би качила това в базата на
        | платформата при първия `push`, без никой да го е поискал.
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
 * Път, дошъл ОТ СЪРВЪРА — валиден ли е за запис ТУК.
 *
 * ⚠ НЕ СЕ ДОВЕРЯВАМЕ НА СЪРВЪРА, И ТОВА НЕ Е НЕДОВЕРИЕ КЪМ ХОРАТА.
 * `pull` взима имената на файловете от плика и пише по тях с правата на
 * човека, който го е пуснал. Отговор `{"path": "../../../../.ssh/authorized_keys"}`
 * — от сбъркан адрес, подменен DNS или човек посредата — би писал извън
 * папката. Сървърът вече пази СЕБЕ СИ със същия бял списък; това тук
 * пази МАШИНАТА НА ТЪРГОВЕЦА, която е друга граница.
 *
 * Три проверки, същите като на сървъра, плюс задържане по РАЗРЕШЕН път:
 * низът може да изглежда невинен и все пак да сочи навън.
 */
function safeRelative(relative) {
  if (typeof relative !== 'string' || relative === '' || relative.includes('\0')) return null;

  const normal = relative.split('\\').join('/');

  if (normal.startsWith('/') || /^[a-zA-Z]:/.test(normal) || normal.split('/').includes('..')) return null;
  if (!DIRECTORIES.includes(normal.split('/')[0])) return null;
  if (!EXTENSIONS.includes(path.extname(normal).toLowerCase())) return null;

  const root = path.resolve(process.cwd());
  const full = path.resolve(root, normal);

  return full === root || full.startsWith(root + path.sep) ? normal : null;
}

function write(relative, content) {
  const safe = safeRelative(relative);

  if (safe === null) {
    say(`  ✗ пропуснат път от сървъра: ${relative}`);

    return false;
  }

  const full = path.join(process.cwd(), safe);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');

  return true;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Командите
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Кой е магазинът, ако човекът не го е казал.
 *
 * ⚠ АДРЕСИТЕ ИСКАТ `public_id` (ULID), А ТОЙ НЕ СЕ ПОКАЗВА НИКЪДЕ В АДМИНА
 * (проверено). Без това откриване единственият начин да подкараш CLI-я е
 * някой да прочете базата — тоест търговец не може да го подкара сам.
 *
 * Един магазин — взима се сам. Повече — изброяват се, защото качване в
 * ПОГРЕШНИЯ магазин е видимо от клиенти — гадането тук не е удобство.
 */
async function discover(cfg) {
  const me = await call({ ...cfg, store: '_' }, 'GET', '/token?include=stores').catch(() => null);

  const stores = me?.stores;

  if (!Array.isArray(stores) || stores.length === 0) return null;
  if (stores.length === 1) return stores[0].id;

  say('  Ключът стига до повече от един магазин — кажи кой с --store:');
  for (const one of stores) say(`    ${one.id}  ${one.name}`);

  return null;
}

async function init(args) {
  const api = flag(args, '--api');
  const version = flag(args, '--version') ?? '2026-07';

  if (!api) die('Искам --api <адрес на магазина>.');

  const theme = flag(args, '--theme');
  const store = flag(args, '--store') ?? await discover({ api, version });

  if (!store) {
    die('Не можах да позная магазина. Добави --store <public_id> от списъка отгоре.');
  }

  saveConfig(theme ? { api, store, version, theme } : { api, store, version });
  say(`  ✓ ${CONFIG}`);

  // ⚠ Ключът не бива да последва конфигурацията в git.
  const ignore = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '';

  /*
  | ⚠ И `.sellanto/` — там живее ГЕНЕРИРАНА справка, която се презаписва
  | при всяко `pull`. Влезе ли в git, всеки пробег прави комит без съдържание,
  | а истинската промяна в темата се губи под шума.
  */
  const want = [TOKEN_FILE, HOME + '/'].filter((one) => !ignore.includes(one));

  if (want.length > 0) {
    fs.writeFileSync(
      '.gitignore',
      `${ignore}${ignore.endsWith('\n') || ignore === '' ? '' : '\n'}${want.join('\n')}\n`,
      'utf8',
    );

    say(`  ✓ .gitignore ← ${want.join(', ')}`);
  }

  say(`\n  Сега: ${ME} pull\n`);
}

/** Темата, както я вижда магазинът в момента — включително доставените файлове. */
/** Колко пътя влизат в една групова заявка — съвпада с `MAX_BATCH` на сървъра. */
const BATCH = 60;

/** Колко БАЙТОВЕ съдържание се пращат наведнъж — съвпада с `MAX_BATCH_BYTES`. */
const BATCH_BYTES = 4 * 1024 * 1024;

/**
 * Разделя списък на партиди — ПО БРОЙ И ПО БАЙТОВЕ.
 *
 * ⚠ БРОЯТ САМ НЕ СТИГА. Шестдесет обикновени шаблона са няколкостотин
 * килобайта, но шест големи `theme.css` са над тавана на сървъра — и
 * цялата партида се отказва с `batch_too_large`. Клиент, който реже само
 * по брой, прави заявка, за която знае предварително, че ще бъде отказана.
 *
 * ⚠ Първият ред влиза винаги: файл, по-голям от партидата, все пак
 * трябва да бъде опитан — сървърът ще каже дали е допустим.
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
 * Темата, както я вижда магазинът — включително доставените файлове.
 *
 * ⚠ НА ПАРТИДИ, А НЕ ФАЙЛ ПО ФАЙЛ. Таванът е 40 заявки в минута на
 * акаунт, а Aurora има 105 редактируеми файла — един файл на заявка
 * значи, че първата стъпка на канала не може да завърши. Сега са две-три.
 */
async function pull(cfg) {
  const listing = await index(cfg);

  const wanted = [];
  let skipped = 0;

  for (const file of listing.files) {
    // Надгробен камък: локално това значи „файлът го няма“.
    if (file.state === 'draft_removed') continue;

    /*
    | ⚠ ПЪТЯТ СЕ ПРОВЕРЯВА ПРЕДИ ЗАЯВКАТА. Той идва от плика, тоест е
    | ВХОД отвън — сървър със сбъркан адрес, подменен DNS или човек
    | посредата може да поиска запис извън папката.
    */
    if (safeRelative(file.path) === null) {
      say(`  ✗ пропуснат път от сървъра: ${file.path}`);
      skipped++;

      continue;
    }

    wanted.push(file.path);
  }

  let written = 0;

  for (const part of batches(wanted)) {
    let rest = part;

    // Байтовият таван на сървъра може да върне ПО-МАЛКО от поисканото
    // (`truncated`) — тогава остатъкът се иска пак, а не се губи.
    while (rest.length > 0) {
      const out = await remote(cfg, 'POST', 'files/read', { paths: rest });
      const got = Array.isArray(out.files) ? out.files : [];

      for (const file of got) {
        if (typeof file.content === 'string' && write(file.path, file.content)) written++;
      }

      const done = new Set(got.map((f) => f.path));

      rest = out.truncated ? rest.filter((path) => !done.has(path)) : [];

      // Без това сървър, който каже `truncated` без да е дал нито един файл,
      // би въртял вечно.
      if (out.truncated && got.length === 0) break;

      say(`  … ${written}/${wanted.length}`);
    }
  }

  if (skipped > 0) say(`  (пропуснати ${skipped})`);

  /*
  | ⚠ И СПРАВКАТА, ЗАЕДНО С ФАЙЛОВЕТЕ. Човек, който току-що е свалил
  | тема, седа да пише Twig в пясъчник, за който не знае нищо. Справка,
  | която се иска с отделна команда, се чете след първия бял екран, не преди.
  */
  await refreshReference(cfg);

  say(`  ✓ ${files(written)} в ${process.cwd()}`);
  say(`\n  Темата е ${listing.theme}. Пиши, после: ${ME} watch\n`);
}

/** Какво се различава — без да качва нищо. */
async function status(cfg) {
  const { changed, removed, listing } = await changes(cfg);

  /*
  | ⚠ И ЗА ИЗОСТАНАЛИТЕ — тук, а не с отделна команда, която никой няма
  | да се сети да пусне. Това е единственият начин човек с папка на своя
  | компютър да разбере, че копието му е от файл, сменен от платформата.
  |
  | ⚠ И НЕ СПИРА `status`, ако адресът го няма: стар сървър без този
  | адрес не бива да прави основната команда неизползваема.
  */
  const behind = await remote(cfg, 'GET', 'conflicts').catch(() => null);

  if (behind !== null && behind.stale > 0) {
    say(`  ⚠ ${files(behind.stale)} ${behind.stale === 1 ? 'е изостанал' : 'са изостанали'} от темата — виж: conflicts`);
  }

  for (const route of removed) say(`  изтрит  ${route}`);

  if (changed.length === 0 && removed.length === 0) {
    say(`  ✓ Няма разлики. ${listing.draft.files === 0 ? 'Черновата е празна.' : `В черновата чака${listing.draft.files === 1 ? '' : 'т'} ${files(listing.draft.files)}.`}`);

    return;
  }

  for (const [route, why] of changed) say(`  ${why}  ${route}`);

  if (changed.length === 0) return;

  say(`\n  ${files(changed.length)} за качване. Пусни: ${ME} push`);
}

/** Качва разликите веднъж. */
async function push(cfg, args = []) {
  const { changed, removed, local } = await changes(cfg);
  const alsoDelete = args.includes('--delete');

  if (changed.length === 0 && (removed.length === 0 || !alsoDelete)) {
    if (removed.length > 0) {
      for (const route of removed) say(`  изтрит  ${route}`);
      say(`\n  липсва${removed.length === 1 ? '' : 'т'} локално: ${files(removed.length)}. За да се махнат и от магазина: push --delete`);

      return;
    }

    say('  ✓ Няма какво да се качи.');

    return;
  }

  /*
  | ⚠ ЕДИН ЗАПИС ЗА ДО ШЕСТДЕСЕТ ФАЙЛА, А НЕ ПО ЕДИН.
  |
  | Същата причина като при `pull`: таванът е 40 заявки в минута. Първо
  | качване на пренесена тема е стотица файла; един на заявка значи, че
  | то не може да стане без няколко минути чакане.
  |
  | ⚠ И ИЗТРИВАНЕТО Е В СЪЩАТА ЗАЯВКА (`content: null`), затова десет
  | изтрити файла не са десет заявки.
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
    | ⚠ ОТКАЗЪТ НОСИ РЕДА, и това е целият смисъл на канала. „Не стана“
    | върху файл от двеста реда не помага на никого.
    */
    for (const one of out.refused ?? []) {
      const where = one.line ? ` (ред ${one.line})` : '';
      const why = one.detail ? `: ${one.detail}` : '';

      say(`  ✗ ${one.path}${where} — ${one.reason}${why}`);
      bad++;
    }
  }

  if (ok === 0) { say(`\n  Нито един файл не влезе в черновата.`); return; }

  const url = (await remote(cfg, 'GET', 'preview')).preview_url;

  say(`\n  ✓ ${files(ok)} в черновата${bad > 0 ? `, ${bad} отказани` : ''}. Виж я:\n    ${url}\n`);
}

/**
 * Качва при всяко запазване.
 *
 * ⚠ ЕДИН ФАЙЛ, ЕДНА ЗАЯВКА, И БЕЗ ОПАШКА. Редакторите пишат по два-три пъти на
 * запазване (временен файл, преименуване, `touch`) — затова има кратко
 * изчакване по път, а не глобално: два различни файла не бива да се чакат.
 */
/**
 * Качва при всяко запазване.
 *
 * =========================================================================
 * ⚠ ПРОМЕНИТЕ СЕ СЪБИРАТ В ЕДНА ЗАЯВКА, А НЕ ЕДНА НА ФАЙЛ
 * =========================================================================
 * Едно запазване от редактор е един файл — но `git checkout`, форматиращ
 * инструмент или преписване на цяла папка е стотици събития в една
 * секунда. По една заявка на файл това удря тавана от 40 в минута и
 * наблюдателят заспива за минути — тоест точно тогава, когато човекът
 * прави най-голямата промяна, каналът спира.
 *
 * Затова събитията се събират в кратък прозорец и тръгват заедно.
 * Прозорецът е и защитата срещу редакторите, които пишат по два-три
 * пъти на запазване (временен файл, преименуване, `touch`).
 *
 * ⚠ И ЕДНА ЗАЯВКА НАВЕДНЪЖ. Докато тече качване, новите събития се
 * трупат за СЛЕДВАЩАТА — иначе два записа на един файл могат да стигнат
 * разменени и черновата да остане с ПРЕДИШНОТО съдържание.
 */
async function watch(cfg) {
  const url = (await remote(cfg, 'GET', 'preview')).preview_url;

  say(`\n  Гледам ${DIRECTORIES.filter((d) => fs.existsSync(d)).join(', ')}`);
  say(`  Прегледът: ${url}`);
  say('  Ctrl+C спира.\n');

  const pending = new Set();
  let timer = null;
  let sending = false;

  const flush = async () => {
    if (sending || pending.size === 0) return;

    sending = true;

    const batch = [...pending];
    pending.clear();

    const payload = batch.map((route) => ({
      path: route,
      // Изчезнал локално значи „върни доставения файл“ — надгробен камък.
      content: fs.existsSync(route) ? fs.readFileSync(route, 'utf8') : null,
    }));

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
        const where = one.line ? ` (ред ${one.line})` : '';
        const why = one.detail ? `: ${one.detail}` : '';

        say(`  ✗ ${one.path}${where} — ${one.reason}${why}`);
      }
    }

    sending = false;

    // Докато течеше тази заявка, може да е се натрупало ново.
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

  // Държи процеса жив, без да върти процесора.
  await new Promise(() => {});
}

async function publish(cfg) {
  const done = await remote(cfg, 'POST', 'publish');

  for (const path of done.paths ?? []) say(`  ▸ ${path}`);

  say(done.published === 0
    ? '  Черновата е празна — нищо не се смени.'
    : `  ✓ ${files(done.published)} сега ${done.published === 1 ? 'е жив' : 'са живи'}.`);
}

async function preview(cfg) {
  const out = await remote(cfg, 'GET', 'preview');

  say(`\n  ${out.preview_url}\n  (ключът живее ${Math.round(out.expires_in / 60)} минути)\n`);
}

async function discard(cfg, args = []) {
  const only = flag(args, '--path');
  const out = await remote(cfg, 'DELETE', `draft${only ? `?path=${encodeURIComponent(only)}` : ''}`);

  say(`  ${out.discarded === 0 ? '✓ Черновата и без това беше празна.' : `✓ Изхвърлен${out.discarded === 1 ? '' : 'и'} ${files(out.discarded)}. Живото не е пипано.`}`);
}

/**
 * Разликата ред по ред — LCS, без нито една зависимост.
 *
 * ⚠ РЕДОВЕ, А НЕ ЗНАЦИ. Шаблон се чете по редове; разлика по знаци върху
 * пренаписан ред дава каша, в която не се вижда нищо.
 *
 * Таблицата е O(n·m) — за файл от няколко хиляди реда това е милиони клетки,
 * тоест мигновено и без грам памет, която да има значение. Голям `theme.css` е
 * единственият случай, в който би се усетило, и той е отрязан по-долу.
 */
function unified(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');

  // Дълъг файл не се разлага — казва се само колко реда са различни.
  if (a.length * b.length > 4_000_000) {
    return [`  (файлът е голям: ${a.length} → ${b.length} реда; разликата не се разлага)`];
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
 * Какво съм сменил спрямо ДОСТАВЕНИЯ файл.
 *
 * ⚠ СПРЯМО ДОСТАВЕНИЯ, А НЕ СПРЯМО ЖИВОТО. „Какво съм пипал по темата“ е
 * въпросът, който човек задава, преди да пусне промяна или преди да я върне;
 * „какво се е сменило от последното качване“ вече го казва `status`.
 */
/**
 * Какво съм сменил спрямо ДОСТАВЕНАТА тема.
 *
 * =========================================================================
 * ДВА РЕЖИМА, ЗАЩОТО ВЪПРОСИТЕ СА ДВА
 * =========================================================================
 * Без път: „кои файла съм пипнал“ — един списък, без нито един байт
 * съдържание. С път: „какво точно“ — една заявка за един файл.
 *
 * ⚠ Първата редакция врътеше заявка ЗА ВСЕКИ СВОЙ ФАЙЛ — тоест търговец
 * със сто презаписани файла удряше тавана от 40 в минута. Точно
 * дефектът, който `pull` и `push` вече не имат, повторен в третата
 * команда, защото тя изглеждаше като „само един файл“.
 */
async function diff(cfg, args = []) {
  const only = args.find((one) => !one.startsWith('--'));
  const listing = await index(cfg);

  const mine = listing.files.filter((f) => f.state === 'live' || f.state === 'draft');

  if (only === undefined) {
    if (mine.length === 0) {
      say('  Няма нито един свой файл — темата е както я доставя платформата.');

      return;
    }

    for (const one of mine) say(`  ${one.state === 'draft' ? 'чернова' : 'живо    '}  ${one.path}`);

    say(`\n  ${files(mine.length)} са твои. За разликата ред по ред: diff <път>\n`);

    return;
  }

  if (!mine.some((f) => f.path === only)) {
    say(`  „${only}“ не е твой файл — темата го доставя непипнат.`);

    return;
  }

  const one = await remote(cfg, 'GET', `files/${encodeURI(only)}`);

  say(`\n  ── ${only}`);

  if (typeof one.delivered !== 'string') {
    say('  (нов файл — платформата не доставя такъв)\n');

    return;
  }

  const lines = unified(one.delivered, one.content ?? '');

  say(lines.length === 0 ? '  (няма разлика)' : lines.join('\n'));
  say('');
}

/**
 * Кои теми може да пипа този магазин.
 *
 * ⚠ ПОДГОТОВКАТА РАБОТИ ЗА ВСЯКА ОТ ТЯХ, ПРЕГЛЕДЪТ — САМО ЗА АКТИВНАТА.
 * Ключът за преглед е обвързан с двойката (магазин, тема), а витрината рисува
 * темата на магазина. Казва се, защото иначе човек подготвя тема и се
 * чуди защо `preview` не показва неговата работа.
 */
async function themes(cfg) {
  const out = await call(cfg, 'GET', 'themes');

  say('');

  for (const one of out.themes ?? []) {
    const mark = one.active ? ' ◀ активна' : '';
    const ready = one.ready ? '' : '   (не е готова)';

    say(`    ${one.theme.padEnd(14)} ${String(one.version || '').padEnd(8)} ${one.name}${mark}${ready}`);
  }

  say(`\n  Сваляне на друга: init --api <адрес> --theme <слуг>`);
  say(`  Преглед работи само за активната; другите се подготвят и се пускат от админа.\n`);
}

/** Версиите на един файл — най-новата отгоре. */
async function versions(cfg, args = []) {
  const only = args.find((one) => !one.startsWith('--'));

  if (!only) die('Искам пътя: versions sections/hero.twig');

  const out = await remote(cfg, 'GET', `files/${encodeURI(only)}/versions`);

  if ((out.versions ?? []).length === 0) {
    say('  Този файл няма история — не е бил публикуван през канала.');

    return;
  }

  say(`\n  ${only}\n`);

  for (const one of out.versions) {
    // ⚠ Празната версия НЕ е „празен файл“, а „тогава нямаше нищо мое“ —
    // връщането към нея е връщане към ТЕМАТА.
    say(`    ${String(one.no).padStart(3)}  ${one.created_at}${one.empty ? '   (тогава беше темата)' : ''}`);
  }

  say(`\n  Връщане: ${ME} restore ${only} --version <номер>\n`);
}

/**
 * Връща файл към стара версия — в ЧЕРНОВАТА.
 *
 * ⚠ БЕЗ --version значи КЪМ ОРИГИНАЛА НА ТЕМАТА, не към последната версия.
 * Двете са различни изречения и второто се казва с число.
 *
 * ⚠ И НЕ Е ЖИВО, докато не кажеш `publish` — каналът има едно обещание. С
 * `--publish` двата хода стават един, но той се иска изрично.
 */
async function restore(cfg, args = []) {
  const only = args.find((one) => !one.startsWith('--') && !/^\d+$/.test(one));

  if (!only) die('Искам пътя: restore sections/hero.twig [--version 3]');

  const asked = flag(args, '--version');
  const version = asked === undefined ? null : Number(asked);

  if (version !== null && !Number.isInteger(version)) die('--version иска цяло число.');

  const out = await remote(cfg, 'POST', `files/${encodeURI(only)}/restore`, { version });

  say(version === null
    ? `  ✓ ${only} → оригинала на темата (в черновата)`
    : `  ✓ ${only} → версия ${version} (в черновата)`);

  if (!args.includes('--publish')) {
    say(`\n  Виж я: ${out.preview_url}`);
    say(`  После: ${ME} publish\n`);

    return;
  }

  await publish(cfg);
}

/**
 * Кои мои файлове са изостанали от темата.
 *
 * ⚠ ПРЕЗАПИСАНИЯТ ФАЙЛ Е КОПИЕ В МИГА НА КОПИРАНЕТО. Темата живее — поправка на
 * дефект, нов drop, ново поле — а магазинът продължава да рисува копието.
 * Работещият локално няма откъде да го научи, освен оттук.
 */
async function conflicts(cfg) {
  const out = await remote(cfg, 'GET', 'conflicts');
  const rows = out.files ?? [];

  if (rows.length === 0) {
    say('  Няма нито един свой файл — няма и какво да изостане.');

    return;
  }

  for (const one of rows) {
    const label = { stale: 'ИЗОСТАНАЛ', unknown: 'не знам  ', fresh: 'актуален ' }[one.state] ?? one.state;

    say(`  ${label}  ${one.path}`);
  }

  say(out.stale === 0
    ? '\n  ✓ Нито един не е изостанал от темата.'
    : `\n  ⚠ ${files(out.stale)} ${out.stale === 1 ? 'е копие' : 'са копия'} на файл, който платформата е сменила оттогава.\n    Сравни с доставения: ${ME} diff <път>`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   Общото между `status`, `push` и `watch`
   ═══════════════════════════════════════════════════════════════════════════ */

const index = (cfg) => remote(cfg, 'GET', 'files');

/**
 * Какво се е сменило от последното качване — ПО ОТПЕЧАТЪК, не по време.
 *
 * ⚠ Не се бърка с командата `diff`, която отговаря на друг въпрос:
 * „какво съм сменил спрямо ДОСТАВЕНИЯ файл“.
 *
 * ⚠ ВРЕМЕТО НА ФАЙЛА НЕ ГОВОРИ ЗА СЪДЪРЖАНИЕТО. `git checkout` на стар клон
 * прави всички файлове „нови“, а редактор, който запазва без промяна, също.
 * Отпечатъкът казва точно едно нещо и то е вярното.
 */
async function changes(cfg) {
  const listing = await index(cfg);
  const local = localFiles();
  const known = new Map(listing.files.map((f) => [f.path, f]));
  const changed = [];

  for (const [route, content] of local) {
    const file = known.get(route);

    if (!file) { changed.push([route, 'нов ']); continue; }
    if (file.hash !== sha256(content)) changed.push([route, 'смен']);
  }

  /*
  | ⚠ ИЗТРИТИТЕ ЛОКАЛНО — САМО СВОИТЕ, И НИКОГА ДОСТАВЕНИТЕ.
  |
  | `watch` вижда събитието „файлът изчезна“ и праща надгробен камък.
  | `push` няма събития — той вижда само две снимки. Без този клон
  | изтриването работеше САМО докато наблюдателят върви — два различни
  | отговора на едно и също действие.
  |
  | ⚠ А НЕ ВСИЧКО, КОЕТО ЛИПСВА ЛОКАЛНО, И ТОВА Е ВАЖНОТО. Човек, който
  | е сложил ЕДИН файл в празна папка и е казал `push`, НЕ иска да изтрие
  | цялата си тема. Затова се гледат само файловете в състояние `live` или
  | `draft` — тези, които той САМ е презаписал. Липсващ `delivered` файл е
  | нормалното състояние на всеки, който не е свалил цялата тема.
  */
  const removed = listing.files
    .filter((f) => (f.state === 'live' || f.state === 'draft') && !local.has(f.path))
    .map((f) => f.path);

  return { changed, removed, local, listing };
}

/**
 * Темата на магазина — пита се веднъж и се помни в `.sellanto.json`.
 *
 * ⚠ НЕ СЕ ЗАКОВАВА РЪЧНО. Магазин, който е сменил темата си, има други файлове;
 * заковано име би качвало в тема, която витрината вече не рисува — и никой не
 * би разбрал защо промените „не се виждат“.
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
   СПРАВКАТА ЗА АВТОРА И ОБНОВЯВАНЕТО НА САМИЯ ИНСТРУМЕНТ
   ═══════════════════════════════════════════════════════════════════════════ */

/** Където живее всичко, което инструментът държи за себе си. */
const HOME = '.sellanto';

const REFERENCE = `${HOME}/THEME-REFERENCE.md`;

/**
 * Справката, както я обявява ПЛАТФОРМАТА — Markdown, за четене до редактора.
 *
 * ⚠ ПИШЕ СЕ ОТ ОТГОВОРА, А НЕ СЕ НОСИ В ТОЗИ ФАЙЛ. Списък с drop-ове и филтри,
 * вграден в клиента, се разминава с платформата при първото ѝ издание — и то
 * мълчаливо, защото човекът чете местния файл и му вярва.
 */
function referenceMarkdown(ref) {
  const lines = [
    '# Темата на този магазин — какво може да ползва',
    '',
    '> ⚠ ТОЗИ ФАЙЛ СЕ ГЕНЕРИРА. Не го редактирай — при следващото `pull` или',
    '> `docs` се презаписва от платформата.',
    '',
    `Тема: **${ref.theme}** ${ref.theme_version ?? ''}`,
    `Отпечатък на договора: \`${(ref.checksum ?? '').slice(0, 12)}\``,
    '',
    '## Как се чете това',
    '',
    'Темата е Twig в **пясъчник**: работи само изброеното тук. Нищо друго не',
    'съществува за шаблона — включително неща, които работят в обикновен Twig',
    '(`|upper`, `|raw`, `source()`, `constant()`, `range`, `..`). Това не е',
    'пропуск: всяко от тях е или опасно, или излишно, а всяко добавено е нова',
    'повърхност.',
    '',
    '⚠ Забраненото **не пада при качване** — то пада при рисуване. Тоест файл с',
    '`|upper` минава проверката и после не рисува секцията. Ако нещо изчезне от',
    'страницата без грешка, първо търси име, което не е в списъците отдолу.',
    '',
    '## Тагове',
    '',
    (ref.tags ?? []).map((one) => `\`{% ${one} %}\``).join(' · '),
    '',
    '## Филтри',
    '',
    (ref.filters ?? []).map((one) => `\`|${one}\``).join(' · '),
    '',
    '## Функции',
    '',
    (ref.functions ?? []).map((one) => `\`${one}()\``).join(' · '),
    '',
    '## Данните (drops)',
    '',
    'Полета извън тези не съществуват — обръщение към такова рисува празно',
    'място, а не грешка.',
    '',
  ];

  for (const [root, ids] of Object.entries(ref.drops ?? {})) {
    lines.push(`### ${root}`, '', ids.map((one) => `\`${one}\``).join(' · '), '');
  }

  const paths = ref.paths ?? {};
  const limits = ref.limits ?? {};

  lines.push(
    '## Кои файлове се редактират',
    '',
    `Папки: ${(paths.directories ?? []).map((one) => `\`${one}/\``).join(' · ')}`,
    '',
    `Разширения: ${(paths.extensions ?? []).map((one) => `\`.${one}\``).join(' · ')}`,
    '',
    '⚠ Чекаутът **не се редактира**, колкото и права да има ключът:',
    (paths.read_only ?? []).map((one) => `\`${one}\``).join(' · '),
    '',
    'Счупена начална страница е неудобство; счупен чекаут са поръчки, които не',
    'се случват, и се вижда чак когато някой погледне оборота.',
    '',
    '## Границите',
    '',
    `- файл: до **${Math.round((limits.max_bytes ?? 0) / 1024)} KB**`,
    `- свои файлове на тема: до **${limits.max_files ?? '?'}**`,
    `- дължина на пътя: до **${limits.max_path ?? '?'}** знака`,
    `- файлове в една групова заявка: до **${limits.max_batch ?? '?'}**`,
    '',
  );

  return lines.join('\n');
}

/**
 * Сваля справката, ако договорът се е разместил.
 *
 * ⚠ ПО ОТПЕЧАТЪК, А НЕ ПО ВЕРСИЯ НА ИЗДАНИЕТО. Издание излиза често и почти
 * никога не мени обявеното към темите; теглене при всяко разгръщане е заявка без
 * отговор. Отпечатъкът се мени ТОЧНО когато нещо в договора е излязло или влязло.
 */
async function refreshReference(cfg, force = false) {
  const ref = await remote(cfg, 'GET', 'reference').catch(() => null);

  if (ref === null) return null;

  const same = cfg.referenceChecksum === ref.checksum && fs.existsSync(REFERENCE);

  if (same && !force) return ref;

  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(REFERENCE, referenceMarkdown(ref) + '\n', 'utf8');

  cfg.referenceChecksum = ref.checksum;
  saveConfig(cfg);

  say(`  ✓ ${REFERENCE}${same ? '' : ' (обновена)'}`);

  return ref;
}

/** Справката, по заявка. */
async function docs(cfg) {
  const ref = await refreshReference(cfg, true);

  if (ref === null) {
    die('Магазинът не дава справка — вероятно е на по-старо издание.');
  }

  say(`\n  Темата е ${ref.theme} ${ref.theme_version ?? ''}.`);
  say(`  ${(ref.filters ?? []).length} филтъра · ${(ref.functions ?? []).length} функции · ${Object.keys(ref.drops ?? {}).length} корена от данни\n`);
}

/* ─────────────────────────── самият инструмент ─────────────────────────── */

/**
 * Има ли по-нова версия на инструмента.
 *
 * ⚠ НАЙ-МНОГО ВЕДНЪЖ НА ДЕН, и това е цялата причина за `checkedAt`. Проверка на
 * всяка команда е по една заявка на всяко натискане срещу таван от 40 в минута —
 * тоест `watch` щеше да го изразходва сам.
 *
 * ⚠ И НЕ СПИРА НИЩО, АКО ПАДНЕ. Стар магазин без този адрес, прекъсната мрежа
 * или изтекъл ключ не бива да правят `push` невъзможен: проверката за версия е
 * удобство, а не част от работата.
 */
async function checkTool(cfg) {
  const day = 24 * 60 * 60 * 1000;

  if (cfg.checkedAt && Date.now() - cfg.checkedAt < day) return;

  const out = await call(cfg, 'GET', '/tools/theme-cli').catch(() => null);

  cfg.checkedAt = Date.now();
  saveConfig(cfg);

  if (out === null || out.version === VERSION) return;

  if (cfg.autoUpdate === true) {
    say(`  … нова версия ${out.version} — обновявам се (autoUpdate)`);
    await applyUpdate(cfg, out);

    return;
  }

  say(`  ⚠ Има нова версия на инструмента: ${out.version} (твоята е ${VERSION}).`);
  say(`    Обнови се с: ${ME} selfupdate\n`);
}

/**
 * Презаписва СЕБЕ СИ с това, което платформата дава.
 *
 * =========================================================================
 * ⚠ ЗАЩО ТОВА НЕ Е АВТОМАТИЧНО ПО ПОДРАЗБИРАНЕ
 * =========================================================================
 * Тук код от мрежата става код на машината на човека. Веригата, по която това
 * се обръща срещу него, е кратка: една сгрешена буква в `--api`, подменен DNS,
 * прокси в чужда мрежа. Затова платформата КАЗВА, а човекът РЕШАВА — освен ако
 * изрично не е сложил `"autoUpdate": true` в `.sellanto.json`.
 *
 * Три огради, и всяка спира различно нещо:
 *   1. **HTTPS** — иска се от `call()` за всеки хост извън лоопбека; срещу
 *      подслушване и подмяна в мрежата;
 *   2. **отпечатък** — изтеглените байтове се сверяват с `sha256` от
 *      описанието; срещу отрязан отговор, страница за грешка и прекъсната мрежа;
 *   3. **форма** — файлът трябва да започва с шапката на Node скрипт и да носи
 *      своя `VERSION`; срещу „200 OK“, което е HTML на портал за вход.
 *
 * ⚠ И СЕ ПИШЕ ПРЕЗ ВРЕМЕНЕН ФАЙЛ С ПРЕИМЕНУВАНЕ. Пряк запис върху работещия
 * скрипт при прекъсване оставя ПОЛОВИН инструмент — тоест човекът губи и
 * начина да се върне.
 */
async function applyUpdate(cfg, meta) {
  const source = await call(cfg, 'GET', '/tools/theme-cli/download', undefined, false, true)
    .catch((e) => { say(`  ✗ ${e.message}`); return null; });

  if (typeof source !== 'string' || source === '') {
    say('  ✗ Платформата не даде инструмента.');

    return false;
  }

  const got = crypto.createHash('sha256').update(source, 'utf8').digest('hex');

  if (meta.sha256 && got !== meta.sha256) {
    say(`  ✗ Отпечатъкът не съвпада (${got.slice(0, 12)} вместо ${String(meta.sha256).slice(0, 12)}) — НЕ записвам.`);

    return false;
  }

  if (!source.startsWith('#!/usr/bin/env node') || !/^const VERSION = '/m.test(source)) {
    say('  ✗ Изтегленото не изглежда като инструмента — НЕ записвам.');

    return false;
  }

  const self = process.argv[1];
  const temp = `${self}.new`;

  /*
  | ⚠ ГЛОБАЛНАТА ИНСТАЛАЦИЯ ЧЕСТО НЕ Е ЗА ПИСАНЕ.
  |
  | `npm i -g` слага файла там, където обикновен потребител няма право да пише.
  | Без това хващане човекът вижда EACCES и стек, тоест не разбира, че
  | инструментът му работи — просто не може да се презапише сам.
  */
  try {
    fs.writeFileSync(temp, source, 'utf8');
    fs.renameSync(temp, self);
  } catch (e) {
    try { fs.unlinkSync(temp); } catch { /* няма какво да се махне */ }

    say(`  ✗ Не мога да запиша ${self} (${e.code ?? e.message}).`);
    say('    Глобална инсталация се обновява с: npm i -g github:sellanto/cli\n');

    return false;
  }

  say(`  ✓ Обновен до ${meta.version}. Пусни командата пак.`);

  return true;
}

async function selfupdate(cfg) {
  const out = await call(cfg, 'GET', '/tools/theme-cli');

  if (out.version === VERSION) {
    say(`  ✓ Вече си на ${VERSION} — няма по-нова.`);

    return;
  }

  say(`  ${VERSION} → ${out.version} (${out.size} байта)`);

  /*
  | ⚠ ОТКАЗЪТ ДА СЕ ЗАПИШЕ Е НЕУСПЕХ И ЗА ИЗХОДНИЯ КОД.
  |
  | Разминат отпечатък, папка без право за писане, отрязан отговор — всичкото
  | се КАЗВА на екрана, но екранът не се чете от cron и от CI. С изход 0
  | автоматизацията мисли, че се е обновила — а точно това не се е случило.
  */
  if (!await applyUpdate(cfg, out)) process.exitCode = 1;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Вратата
   ═══════════════════════════════════════════════════════════════════════════ */

const HELP = `
  Темата на магазина ти, локално.

  Повиква се с «${ME}»:

    init --api <адрес> [--store <public_id>] [--theme <слуг>]
    themes                   кои теми може да пипа този магазин
    pull                     сваля темата тук
    status                   какво се различава
    push [--delete]          качва разликите в черновата
    watch                    същото, при всяко запазване
    preview                  адресът, на който се вижда
    publish                  черновата става жива
    discard [--path <път>]   изхвърля черновата

    diff [<път>]           какво съм сменил спрямо доставената тема
    conflicts               кои мои файла са изостанали от темата
    versions <път>         историята на един файл
    restore <път> [--version N] [--publish]
                            връща файл назад (без --version: към темата)

    docs                    справката за тази тема → .sellanto/THEME-REFERENCE.md
    selfupdate              обновява самия инструмент

  Без --store се открива сам, ако ключът стига до един магазин.
  "push" без --delete НЕ маха нищо — само казва кое липсва локално.

  Ключът е в SELLANTO_TOKEN или в ${TOKEN_FILE}. Инструментът е ${VERSION}.
  Пълната инструкция: github.com/sellanto/cli (и /dev/docs, раздел CLI).
`;

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help') { say(HELP); return; }
  if (command === 'init') { await init(args); return; }

  const cfg = config();

  /*
  | ⚠ ТЕМАТА СЕ РАЗРЕШАВА ПРЕДИ ВСЯКА КОМАНДА, А НЕ СЕ ЧЕТЕ ОТ ФАЙЛА.
  |
  | Слугът в `.sellanto.json` е само запомненото от миналия път. Магазин, който
  | е сменил темата си от админа, трябва да бъде последван — иначе всяко
  | качване отива в тема, която витрината не рисува, и мълчи.
  */
  const slug = await theme(cfg);

  if (!slug) {
    die(['Не мога да позная темата на магазина.', (lastError?.message ?? ''), 'Ключът иска обхват write_theme_code („Запис · Код на темата"), право themes.edit_code и план с редактор на код.'].join('\n   '));
  }

  /*
  | ⚠ ИЗБРАНАТА ТЕМА НЕ СЕ ПРЕЗАПИСВА ОТ АКТИВНАТА.
  |
  | Каналът приема всяка тема, до която акаунтът има право — тоест човек,
  | който ПОДГОТВЯ `kometa`, докато магазинът рисува `aurora`, не бива да
  | бъде мълчаливо прехвърлен обратно. Разликата се КАЗВА веднъж,
  | защото това е и причината `preview` да не показва тази работа.
  */
  if (cfg.theme !== undefined && cfg.theme !== slug) {
    say(`  ℹ Подготвяш ${cfg.theme}; магазинът рисува ${slug}. Прегледът показва ${slug}.`);
  } else if (cfg.theme !== slug) {
    cfg.theme = slug;
    saveConfig(cfg);
    say(`  Темата на магазина е ${slug}.`);
  }

  /*
  | ⚠ ПРОВЕРКАТА ЗА НОВА ВЕРСИЯ Е ПРЕДИ КОМАНДАТА, но НЕ я спира.
  |
  | Стар клиент срещу ново API вижда „не стана“ вместо изречение — тоест
  | версията му е част от съвместимостта. Но проверка, която спира
  | работата, когато мрежата прекъсне, е по-лоша от стар клиент.
  */
  if (command !== 'selfupdate') await checkTool(cfg);

  const commands = { pull, status, push, watch, preview, publish, discard, diff, versions, restore, conflicts, docs, selfupdate, themes };

  if (!commands[command]) die(`Няма команда \`${command}\`.${HELP}`);

  await commands[command](cfg, args);
}

main().catch((error) => die(error.message));
