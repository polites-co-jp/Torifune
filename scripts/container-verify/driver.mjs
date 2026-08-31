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
 */
import { crc32 } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

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

const command = process.argv[2];
const commands = {
  setup,
  'install-broken': installBroken,
  'install-example': installExample,
  state,
};
if (commands[command] === undefined) {
  fail(`不明なコマンド: ${command}`);
}
await commands[command]();
