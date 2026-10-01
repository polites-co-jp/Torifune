/**
 * コンテナの中で動かす検証ドライバ（`012-plugin-manager` #30-#33）。
 *
 * **本番と同じイメージの中で、HTTP 越しに実際の導入フローを叩く。**
 * ホストへポートを公開しないため、`docker exec` でここを実行する。
 *
 * 呼び出し方:
 *   node driver.mjs setup      最初の管理者を作ってセッションを保存する
 *   node driver.mjs install-broken   ビルドを壊す Plugin を Package として導入する
 *   node driver.mjs install-example  サンプル Plugin を導入する（隔離後の再ビルド確認）
 *   node driver.mjs state      Plugin と操作の状態を JSON で出す
 *
 * `050-bundled-plugin-sync` #43-#49（`scripts/verify-bundled-plugin-sync.sh`）が使うもの:
 *   node driver.mjs login                    既にいる管理者でログインし直す（コンテナを作り直した後）
 *   node driver.mjs install-user             検証用の小さな Plugin を Package として導入する
 *   node driver.mjs enable <pluginId>        Plugin を有効化する
 *   node driver.mjs uninstall <pluginId>     Plugin をファイルごと削除する（データは消さない）
 *   node driver.mjs plugin <pluginId>        1 つの Plugin の状態を 1 行の JSON で出す
 *   node driver.mjs help <pluginId> <docId>  手順書の本文が読めることを確かめる
 *   node driver.mjs markers <pluginId>...    各フォルダの同梱の印と木のハッシュを 1 行の JSON で出す
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

const BASE = 'http://127.0.0.1:3000';
const SESSION_FILE = '/tmp/torifune-verify-session.json';

const ADMIN = {
  loginId: 'container_verify_admin',
  displayName: 'コンテナ検証',
  email: 'container-verify@example.com',
  password: 'container verify correct horse battery staple',
};

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

/** **名前で上書きする。** 並べるだけだと古い CSRF トークンが先に読まれる。 */
const jar = new Map();

function absorb(response) {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';')[0];
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

function cookieHeader() {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function saveSession() {
  writeFileSync(SESSION_FILE, JSON.stringify([...jar]), 'utf8');
}

function loadSession() {
  for (const [name, value] of JSON.parse(readFileSync(SESSION_FILE, 'utf8'))) {
    jar.set(name, value);
  }
}

async function csrf() {
  const response = await fetch(`${BASE}/api/v1/auth/csrf`, { headers: { Cookie: cookieHeader() } });
  absorb(response);
  return (await response.json()).data.csrfToken;
}

function fail(message) {
  console.error(`NG: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 最小の ZIP 書き出し（無圧縮）
//
// コンテナの中に zip コマンドを足したくないため、ここで組み立てる。
// `apps/web/src/test-support/zip.ts` と同じ考え方だが、あちらは TypeScript で
// あり、本番イメージには TS の実行環境が無い。
// ---------------------------------------------------------------------------

function buildZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.content, 'utf8');
    const sum = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(sum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(sum, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    // 通常ファイル 0o100644。
    // **シフトで組み立てない。** `<<` は 32bit 符号付きなので負になる。
    directory.writeUInt32LE(0o100644 * 0x10000, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);

    offset += header.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...local, centralBuffer, end]);
}

/**
 * **Manifest は正しいが、ビルドの段階で失敗する Plugin。**
 *
 * 導入前の検証（Manifest / パス / シンボリックリンク）はすべて通る。
 * 解決できない import があるので `next build` だけが落ちる。
 * 「検証を抜けてビルドを壊す Plugin」を再現するのが目的。
 */
function brokenPackage() {
  return buildZip([
    {
      name: 'broken-plugin/plugin.json',
      content: JSON.stringify(
        {
          id: 'broken-plugin',
          name: 'ビルドを壊すPlugin',
          version: '1.0.0',
          apiVersion: 1,
          description: 'コンテナ検証用。Manifest は正しいがビルドが失敗する。',
          author: 'Torifune',
          license: 'MIT',
          permissions: [],
          extensions: ['ui'],
        },
        null,
        2,
      ),
    },
    {
      name: 'broken-plugin/index.tsx',
      content: [
        "import type { Plugin, PluginContext } from '@torifune/plugin-api';",
        "import { missing } from './this-module-does-not-exist';",
        '',
        'const plugin: Plugin = {',
        '  activate(context: PluginContext): void {',
        '    context.logger.info(String(missing));',
        '  },',
        '};',
        '',
        'export default plugin;',
        '',
      ].join('\n'),
    },
  ]);
}

// ---------------------------------------------------------------------------
// コマンド
// ---------------------------------------------------------------------------

async function setup() {
  const token = await csrf();
  const response = await fetch(`${BASE}/api/v1/setup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE,
      'X-CSRF-Token': token,
      Cookie: cookieHeader(),
    },
    body: JSON.stringify({ ...ADMIN, csrfToken: token }),
  });
  absorb(response);
  if (response.status !== 201) {
    fail(`/setup が 201 を返さなかった: ${response.status} ${await response.text()}`);
  }

  const loginToken = await csrf();
  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE,
      'X-CSRF-Token': loginToken,
      Cookie: cookieHeader(),
    },
    body: JSON.stringify({
      loginId: ADMIN.loginId,
      password: ADMIN.password,
      csrfToken: loginToken,
    }),
  });
  absorb(login);
  if (login.status !== 200) fail(`ログインできなかった: ${login.status}`);

  saveSession();
  console.log('OK: 管理者を作成してログインした');
}

async function installBroken() {
  loadSession();
  const archive = brokenPackage();

  // 導入前の検証は通る。**ビルドを壊すことは Manifest からは分からない。**
  const inspectToken = await csrf();
  const inspectForm = new FormData();
  inspectForm.set('file', new Blob([archive]), 'broken-plugin.zip');
  const inspect = await fetch(`${BASE}/api/v1/plugins/package/inspect`, {
    method: 'POST',
    headers: { Origin: BASE, 'X-CSRF-Token': inspectToken, Cookie: cookieHeader() },
    body: inspectForm,
  });
  absorb(inspect);
  if (inspect.status !== 200) {
    fail(`inspect が 200 を返さなかった: ${inspect.status} ${await inspect.text()}`);
  }

  const token = await csrf();
  const form = new FormData();
  form.set('file', new Blob([archive]), 'broken-plugin.zip');
  form.set('pluginId', 'broken-plugin');
  const response = await fetch(`${BASE}/api/v1/plugins/package/install`, {
    method: 'POST',
    headers: { Origin: BASE, 'X-CSRF-Token': token, Cookie: cookieHeader() },
    body: form,
  });
  absorb(response);
  const body = await response.text();
  if (response.status !== 201) fail(`導入が 201 を返さなかった: ${response.status} ${body}`);
  if (!body.includes('"willRestart":true')) fail(`再起動が予約されなかった: ${body}`);

  console.log('OK: 壊れた Plugin の導入を受け付け、再ビルドを予約した');
}

async function installExample() {
  loadSession();
  const token = await csrf();
  const response = await fetch(`${BASE}/api/v1/plugins`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE,
      'X-CSRF-Token': token,
      Cookie: cookieHeader(),
    },
    body: JSON.stringify({
      pluginId: 'example-plugin',
      acknowledgedPermissions: true,
      csrfToken: token,
    }),
  });
  absorb(response);
  const body = await response.text();
  if (response.status !== 201) fail(`導入が 201 を返さなかった: ${response.status} ${body}`);
  console.log('OK: サンプル Plugin の導入を受け付け、再ビルドを予約した');
}

async function state() {
  loadSession();
  // 画面を1枚開く。ここで Plugin の起動と操作の照合が走る。
  const page = await fetch(`${BASE}/dashboard`, { headers: { Cookie: cookieHeader() } });
  if (page.status !== 200) fail(`/dashboard が 200 を返さなかった: ${page.status}`);

  const response = await fetch(`${BASE}/api/v1/plugins`, { headers: { Cookie: cookieHeader() } });
  const body = await response.json();
  console.log(
    JSON.stringify({
      installed: body.data.installed.map((p) => ({ id: p.id, status: p.status })),
      detected: body.data.detected.map((p) => p.id),
      operations: body.data.operations.map((o) => ({
        pluginId: o.pluginId,
        kind: o.kind,
        status: o.status,
      })),
    }),
  );
}

// ---------------------------------------------------------------------------
// 050-bundled-plugin-sync（#43-#49）
// ---------------------------------------------------------------------------

const PLUGINS_DIR = process.env.TORIFUNE_PLUGINS_DIR || '/app/plugins';
const BUNDLED_DIR = process.env.TORIFUNE_BUNDLED_PLUGINS_DIR || '/app/.torifune-bundled-plugins';
const USER_PLUGIN_ID = 'verify-user-plugin';
const HELP_READ_FAILED_FRAGMENT = 'この手順書を読み込めませんでした';

/** 引数の ID の形を確かめる（URL とパスへそのまま入れるため）。 */
function argument(index, label) {
  const value = process.argv[index];
  if (value === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    fail(`${label} を指定してください: ${String(value)}`);
  }
  return value;
}

async function sendJson(path, method, body) {
  const token = await csrf();
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE,
      'X-CSRF-Token': token,
      Cookie: cookieHeader(),
    },
    body: JSON.stringify({ ...body, csrfToken: token }),
  });
  absorb(response);
  return { status: response.status, body: await response.text() };
}

async function login() {
  const result = await sendJson('/api/v1/auth/login', 'POST', {
    loginId: ADMIN.loginId,
    password: ADMIN.password,
  });
  if (result.status !== 200) fail(`ログインできなかった: ${result.status}`);
  saveSession();
  console.log('OK: 管理者でログインし直した');
}

/** 利用者が導入する Plugin の代わり。Manifest も本体も最小で、ビルドは通る。 */
function userPackage() {
  return buildZip([
    {
      name: `${USER_PLUGIN_ID}/plugin.json`,
      content: JSON.stringify(
        {
          id: USER_PLUGIN_ID,
          name: '検証用の利用者のPlugin',
          version: '1.0.0',
          apiVersion: 1,
          description: 'コンテナ検証用。利用者が Package で導入した Plugin の代わり。',
          author: 'Torifune',
          license: 'MIT',
          permissions: [],
          extensions: ['ui'],
        },
        null,
        2,
      ),
    },
    {
      name: `${USER_PLUGIN_ID}/index.ts`,
      content: [
        "import type { Plugin, PluginContext } from '@torifune/plugin-api';",
        '',
        'const plugin: Plugin = {',
        '  activate(context: PluginContext): void {',
        `    context.logger.info('${USER_PLUGIN_ID} activated');`,
        '  },',
        '};',
        '',
        'export default plugin;',
        '',
      ].join('\n'),
    },
  ]);
}

async function installUser() {
  loadSession();
  const archive = userPackage();

  const inspectToken = await csrf();
  const inspectForm = new FormData();
  inspectForm.set('file', new Blob([archive]), `${USER_PLUGIN_ID}.zip`);
  const inspect = await fetch(`${BASE}/api/v1/plugins/package/inspect`, {
    method: 'POST',
    headers: { Origin: BASE, 'X-CSRF-Token': inspectToken, Cookie: cookieHeader() },
    body: inspectForm,
  });
  absorb(inspect);
  if (inspect.status !== 200) {
    fail(`inspect が 200 を返さなかった: ${inspect.status} ${await inspect.text()}`);
  }

  const token = await csrf();
  const form = new FormData();
  form.set('file', new Blob([archive]), `${USER_PLUGIN_ID}.zip`);
  form.set('pluginId', USER_PLUGIN_ID);
  const response = await fetch(`${BASE}/api/v1/plugins/package/install`, {
    method: 'POST',
    headers: { Origin: BASE, 'X-CSRF-Token': token, Cookie: cookieHeader() },
    body: form,
  });
  absorb(response);
  const body = await response.text();
  if (response.status !== 201) fail(`導入が 201 を返さなかった: ${response.status} ${body}`);
  if (!body.includes('"willRestart":true')) fail(`再起動が予約されなかった: ${body}`);
  console.log('OK: 利用者の Plugin の導入を受け付け、再ビルドを予約した');
}

async function enable() {
  loadSession();
  const id = argument(3, 'Plugin ID');
  const result = await sendJson(`/api/v1/plugins/${id}/enable`, 'POST', {});
  if (result.status !== 200) fail(`有効化が 200 を返さなかった: ${result.status} ${result.body}`);
  console.log(`OK: ${id} を有効化した`);
}

async function uninstall() {
  loadSession();
  const id = argument(3, 'Plugin ID');
  const result = await sendJson(`/api/v1/plugins/${id}`, 'DELETE', {
    deleteFiles: true,
    deleteData: false,
    confirm: id,
  });
  if (result.status !== 200) fail(`削除が 200 を返さなかった: ${result.status} ${result.body}`);
  if (!result.body.includes('"willRestart":true')) {
    fail(`再起動が予約されなかった: ${result.body}`);
  }
  console.log(`OK: ${id} をファイルごと削除し、再ビルドを予約した`);
}

async function plugin() {
  loadSession();
  const id = argument(3, 'Plugin ID');
  // 画面を1枚開く。ここで Plugin の起動と操作の照合が走る（state と同じ）。
  const page = await fetch(`${BASE}/dashboard`, { headers: { Cookie: cookieHeader() } });
  if (page.status !== 200) fail(`/dashboard が 200 を返さなかった: ${page.status}`);

  const response = await fetch(`${BASE}/api/v1/plugins`, { headers: { Cookie: cookieHeader() } });
  if (response.status !== 200) fail(`/api/v1/plugins が 200 を返さなかった: ${response.status}`);
  const body = await response.json();
  const installed = body.data.installed.find((p) => p.id === id);
  if (installed !== undefined) {
    console.log(JSON.stringify({ id, status: installed.status, loaded: installed.loaded }));
    return;
  }
  if (body.data.detected.some((p) => p.id === id)) {
    console.log(JSON.stringify({ id, detected: true }));
    return;
  }
  console.log(JSON.stringify({ id, absent: true }));
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&');
}

/** Markdown の行から、HTML にしたときに文字として残る部分（強調・コード・リンクの記号を除く）。 */
function plainMarkdownLine(line) {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .trim();
}

/**
 * 手順書の本文が**読めている**ことを確かめる。
 *
 * 本文が読めなくても画面は 200 で、Manifest の題名を出す（041 設計 §7.3.5）。題名だけでは
 * 読めたかを見分けられないので、読めないときの注記が無いことと、本文の最初の段落の行
 * （同梱の写しの Markdown の、`#`・`>` で始まらない最初の空でない行）が出ていることを見る
 * （050 実装プラン §8 の 9）。
 */
async function help() {
  loadSession();
  const id = argument(3, 'Plugin ID');
  const docId = argument(4, '手順書 ID');

  const manifest = JSON.parse(readFileSync(join(BUNDLED_DIR, id, 'plugin.json'), 'utf8'));
  const doc = (manifest.help ?? []).find((entry) => entry.id === docId);
  if (doc === undefined) fail(`同梱の写しの ${id} に手順書 ${docId} の宣言が無い`);
  const markdown = readFileSync(join(BUNDLED_DIR, id, doc.path), 'utf8').replaceAll('\r\n', '\n');
  const firstLine = markdown
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '' && !line.startsWith('#') && !line.startsWith('>'));
  if (firstLine === undefined) fail(`${doc.path} に本文の段落が無い`);
  const expected = plainMarkdownLine(firstLine);

  // ログイン画面へ回されたものを 200 と取り違えないよう、転送を辿らない。
  const response = await fetch(`${BASE}/plugins/${id}/help/${docId}`, {
    headers: { Cookie: cookieHeader() },
    redirect: 'manual',
  });
  const html = await response.text();
  if (response.status !== 200) fail(`手順書の画面が 200 を返さなかった: ${response.status}`);
  const text = decodeEntities(html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ''));
  if (text.includes(HELP_READ_FAILED_FRAGMENT)) {
    fail(`手順書の本文が読めていない（${id}/${docId}）`);
  }
  if (!text.includes(doc.title)) fail(`手順書の見出し「${doc.title}」が無い`);
  if (!text.includes(expected)) fail(`手順書の本文の最初の段落「${expected}」が無い`);
  console.log(`OK: ${id}/${docId} の本文を読めた`);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * フォルダの木のハッシュ（050 設計 §6.2.1）。**検証のため、本体とは別にここで計算する。**
 *
 * 通常のファイルとシンボリックリンク（リンク先の文字列。辿らない）を数え、直下の印と隔離マークを除く。
 * 各項目 `<f|l>\0<相対パス>\0<SHA-256>\n` を相対パスの昇順に連結し、SHA-256 を取る。
 */
function treeHash(root) {
  const items = [];
  const walk = (relative) => {
    const absolute = relative === '' ? root : join(root, relative);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (
        relative === '' &&
        (entry.name === '.torifune-bundled' || entry.name === '.torifune-quarantine')
      ) {
        continue;
      }
      const rel = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const path = join(root, rel);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        items.push({ rel, line: `l\0${rel}\0${sha256(readlinkSync(path))}\n` });
      } else if (stat.isDirectory()) {
        walk(rel);
      } else if (stat.isFile()) {
        items.push({ rel, line: `f\0${rel}\0${sha256(readFileSync(path))}\n` });
      }
    }
  };
  walk('');
  items.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return `sha256:${sha256(items.map((item) => item.line).join(''))}`;
}

/** 印（`.torifune-bundled`）の `hash`。無い・読めない・文字列でなければ null。 */
function markerHash(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, '.torifune-bundled'), 'utf8'));
    return typeof parsed.hash === 'string' ? parsed.hash : null;
  } catch {
    return null;
  }
}

/** 各 ID の `{ id, exists, tree, marker }` の配列。`marker` は印の `hash`（無い・読めなければ null）。 */
function markers() {
  const ids = process.argv.slice(3);
  if (ids.length === 0) fail('Plugin ID を 1 つ以上指定してください');
  const result = ids.map((id) => {
    const dir = join(PLUGINS_DIR, id);
    if (!existsSync(dir)) return { id, exists: false, tree: null, marker: null };
    return { id, exists: true, tree: treeHash(dir), marker: markerHash(dir) };
  });
  console.log(JSON.stringify(result));
}

const command = process.argv[2];
const commands = {
  setup,
  'install-broken': installBroken,
  'install-example': installExample,
  state,
  login,
  'install-user': installUser,
  enable,
  uninstall,
  plugin,
  help,
  markers,
};
if (commands[command] === undefined) {
  fail(`不明なコマンド: ${command}`);
}
await commands[command]();
