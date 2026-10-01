import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * コンテナの起動手順（`docker/entrypoint.sh`）の同期と起動時の突き合わせ
 * （050-bundled-plugin-sync 設計 §6.5・§6.7、受け入れ条件 #34〜#42。種別 S）。
 *
 * entrypoint を `sh` で実際に動かし、外へ出るコマンドをすべてスタブにする。
 *
 * * `TORIFUNE_CLI_CMD`（同期と指紋）・`TORIFUNE_BUILD_CMD`（ビルド）・`TORIFUNE_START_CMD`（起動）を
 *   `sh <スタブ>` にする（実行ビットに頼らない。実装プラン §8 の 13）
 * * `.next`（`TORIFUNE_NEXT_DIR`）・直前の成功ビルドの退避（`TORIFUNE_BUILD_STATE_DIR`）・sentinel・
 *   plugins・同梱の写しの場所は一時ディレクトリへ向ける
 * * スタブは呼ばれた順に記録ファイルへ 1 行ずつ書く（`sync […]`・`fingerprint […]`・`build`・`start`）。
 *   「起動の前に」は記録の行の順で見る
 * * 指紋のスタブはファイル `fp-current` の中身を出す。ビルドのスタブは成功すると `fp-current` を
 *   `fp-after-build` で上書きする。書かれた指紋が「ビルドの**前に**計算した値」かを見分けるため（#37）
 * * `sh` が無い環境では飛ばす（設計 §10 の S の注）。CI（Linux）では必ず走る
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const ENTRYPOINT = toShellPath(join(REPO_ROOT, 'docker', 'entrypoint.sh'));

const SH_AVAILABLE = (() => {
  try {
    return spawnSync('sh', ['-c', 'exit 0'], { timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
})();

if (!SH_AVAILABLE) {
  console.info('[entrypoint-startup.test] sh を起動できないため、#34〜#42 を飛ばした');
}

const FP_BAKED = `sha256:${'a'.repeat(64)}`;
const FP_CURRENT = `sha256:${'b'.repeat(64)}`;
const FP_AFTER_BUILD = `sha256:${'c'.repeat(64)}`;
const FP_CHANGED_IN_LOOP = `sha256:${'d'.repeat(64)}`;

const BAKED_BUILD_ID = 'baked-build';

/** Windows の区切り（`\`）を `sh` に渡せる `/` へ直す。 */
function toShellPath(path: string): string {
  return path.replaceAll('\\', '/');
}

interface Layout {
  readonly root: string;
  readonly stubs: string;
  readonly nextDir: string;
  readonly stateDir: string;
  readonly sentinel: string;
  readonly pluginsDir: string;
  readonly bundledDir: string;
  readonly callsLog: string;
}

let layout: Layout;

function file(name: string): string {
  return join(layout.stubs, name);
}

function writeStubs(l: Layout): void {
  const d = toShellPath(l.stubs);
  const n = toShellPath(l.nextDir);

  writeFileSync(
    join(l.stubs, 'cli-stub.sh'),
    [
      '#!/bin/sh',
      `D='${d}'`,
      'if [ "${1:-}" = plugins ] && [ "${2:-}" = sync-bundled ]; then',
      '  shift 2',
      '  { printf "sync"; for a in "$@"; do printf " [%s]" "$a"; done; printf "\\n"; } >> "$D/calls.log"',
      '  echo "[torifune] bundled plugins: summary updated=0 restored=0 adopted=0 unchanged=0 skipped=0 kept=0 failed=0 untouched=0"',
      '  if [ -f "$D/sync-fail" ]; then echo "[torifune] bundled plugins: stub FAILED: EIO" >&2; exit 1; fi',
      '  exit 0',
      'fi',
      'if [ "${1:-}" = plugins ] && [ "${2:-}" = fingerprint ]; then',
      '  shift 2',
      '  { printf "fingerprint"; for a in "$@"; do printf " [%s]" "$a"; done; printf "\\n"; } >> "$D/calls.log"',
      '  if [ -f "$D/fp-fail" ]; then echo "stub: cannot fingerprint" >&2; exit 1; fi',
      '  cat "$D/fp-current"',
      '  exit 0',
      'fi',
      '{ printf "cli-unknown"; for a in "$@"; do printf " [%s]" "$a"; done; printf "\\n"; } >> "$D/calls.log"',
      'exit 2',
      '',
    ].join('\n'),
    'utf8',
  );

  writeFileSync(
    join(l.stubs, 'build-stub.sh'),
    [
      '#!/bin/sh',
      `D='${d}'`,
      `N='${n}'`,
      'echo build >> "$D/calls.log"',
      'count=$(cat "$D/build-count" 2>/dev/null || echo 0)',
      'count=$((count + 1))',
      'echo "$count" > "$D/build-count"',
      // next build と同じく、まず .next を消す。
      'rm -rf "$N"',
      'mkdir -p "$N"',
      'if [ -f "$D/build-fail" ]; then',
      '  echo broken > "$N/BROKEN"',
      '  exit 1',
      'fi',
      'echo "build-$count" > "$N/BUILD_ID"',
      'if [ -f "$D/fp-after-build" ]; then cp "$D/fp-after-build" "$D/fp-current"; fi',
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );

  writeFileSync(
    join(l.stubs, 'start-stub.sh'),
    [
      '#!/bin/sh',
      `D='${d}'`,
      `N='${n}'`,
      'echo start >> "$D/calls.log"',
      'count=$(cat "$D/start-count" 2>/dev/null || echo 0)',
      'count=$((count + 1))',
      'echo "$count" > "$D/start-count"',
      // 起動の時点の .next を残す（「起動の前に」何が起きていたかを見る）。
      '{ cat "$N/BUILD_ID" 2>/dev/null || echo "-"; cat "$N/torifune-plugin-sources" 2>/dev/null || echo "-"; } > "$D/seen-$count"',
      'if [ -f "$D/start-$count.sh" ]; then . "$D/start-$count.sh"; fi',
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'torifune-entrypoint-'));
  layout = {
    root,
    stubs: join(root, 'stubs'),
    nextDir: join(root, 'next'),
    stateDir: join(root, 'state'),
    sentinel: join(root, 'rebuild-request'),
    pluginsDir: join(root, 'plugins'),
    bundledDir: join(root, 'bundled'),
    callsLog: join(root, 'stubs', 'calls.log'),
  };
  mkdirSync(layout.stubs);
  mkdirSync(layout.pluginsDir);
  mkdirSync(layout.bundledDir);
  writeStubs(layout);

  // 焼き込まれたビルド：BUILD_ID と、そのビルドの指紋。
  mkdirSync(layout.nextDir);
  writeFileSync(join(layout.nextDir, 'BUILD_ID'), `${BAKED_BUILD_ID}\n`, 'utf8');
  writeFileSync(join(layout.nextDir, 'torifune-plugin-sources'), `${FP_BAKED}\n`, 'utf8');

  // 既定は「いまの指紋 = ビルドの指紋」（起動前の再ビルドは要らない）。
  setCurrentFingerprint(FP_BAKED);
  writeFileSync(file('fp-after-build'), `${FP_AFTER_BUILD}\n`, 'utf8');
});

afterEach(() => {
  rmSync(layout.root, { recursive: true, force: true });
});

function setCurrentFingerprint(value: string): void {
  writeFileSync(file('fp-current'), `${value}\n`, 'utf8');
}

function setBuildFingerprint(value: string | null): void {
  const path = join(layout.nextDir, 'torifune-plugin-sources');
  if (value === null) {
    rmSync(path, { force: true });
  } else {
    writeFileSync(path, `${value}\n`, 'utf8');
  }
}

function flag(name: 'sync-fail' | 'fp-fail' | 'build-fail'): void {
  writeFileSync(file(name), '', 'utf8');
}

/** n 回目の起動のスタブが（終了の前に）実行する手順。`exit 75` で再ビルドを求められる。 */
function onStart(n: number, script: string): void {
  writeFileSync(file(`start-${n}.sh`), `${script}\n`, 'utf8');
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: readonly string[];
}

function runEntrypoint(overrides: Readonly<Record<string, string | undefined>> = {}): RunResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TORIFUNE_CLI_CMD: `sh ${toShellPath(file('cli-stub.sh'))}`,
    TORIFUNE_BUILD_CMD: `sh ${toShellPath(file('build-stub.sh'))}`,
    TORIFUNE_START_CMD: `sh ${toShellPath(file('start-stub.sh'))}`,
    TORIFUNE_NEXT_DIR: toShellPath(layout.nextDir),
    TORIFUNE_BUILD_STATE_DIR: toShellPath(layout.stateDir),
    TORIFUNE_REBUILD_SENTINEL: toShellPath(layout.sentinel),
    TORIFUNE_PLUGINS_DIR: toShellPath(layout.pluginsDir),
    TORIFUNE_BUNDLED_PLUGINS_DIR: toShellPath(layout.bundledDir),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const result = spawnSync('sh', [ENTRYPOINT], {
    env,
    cwd: layout.root,
    encoding: 'utf8',
    timeout: 30_000,
  });

  const calls = existsSync(layout.callsLog)
    ? readFileSync(layout.callsLog, 'utf8')
        .replaceAll('\r\n', '\n')
        .split('\n')
        .filter((line) => line !== '')
    : [];

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    calls,
  };
}

function kind(line: string): string {
  return line.split(' ')[0] ?? '';
}

/** 最初の `start` より前の記録。`start` が無ければ全部。 */
function beforeFirstStart(calls: readonly string[]): readonly string[] {
  const index = calls.findIndex((line) => kind(line) === 'start');
  return index === -1 ? calls : calls.slice(0, index);
}

function count(calls: readonly string[], name: string): number {
  return calls.filter((line) => kind(line) === name).length;
}

function readTrimmed(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
}

function buildFingerprintFile(): string | null {
  return readTrimmed(join(layout.nextDir, 'torifune-plugin-sources'));
}

function buildIdFile(): string | null {
  return readTrimmed(join(layout.nextDir, 'BUILD_ID'));
}

describe.skipIf(!SH_AVAILABLE)('起動の最初の同期', () => {
  it('#34 同期のスタブが最初の起動コマンドより前に呼ばれる', () => {
    const { status, calls } = runEntrypoint();

    expect(status).toBe(0);
    expect(count(beforeFirstStart(calls), 'sync')).toBe(1);
    expect(count(calls, 'start')).toBe(1);
  });

  it('#34 同期のスタブに --bundled-dir と --plugins-dir が付く', () => {
    const { calls } = runEntrypoint();

    const sync = calls.find((line) => kind(line) === 'sync');
    expect(sync, `同期が呼ばれていない: ${JSON.stringify(calls)}`).toBeDefined();
    expect(sync).toContain(`[--bundled-dir=${toShellPath(layout.bundledDir)}]`);
    expect(sync).toContain(`[--plugins-dir=${toShellPath(layout.pluginsDir)}]`);
  });

  it('#34 監視ループで起動し直しても、同期は 1 回だけ（起動の最初だけ）', () => {
    onStart(1, `touch '${toShellPath(layout.sentinel)}'\nexit 75`);

    const { status, calls } = runEntrypoint();

    expect(status).toBe(0);
    expect(count(calls, 'start')).toBe(2);
    expect(count(calls, 'sync')).toBe(1);
    expect(count(beforeFirstStart(calls), 'sync')).toBe(1);
  });

  it('#34 TORIFUNE_BUNDLED_PLUGINS_DIR が空なら同期は呼ばれない（起動はする）', () => {
    const { status, calls } = runEntrypoint({ TORIFUNE_BUNDLED_PLUGINS_DIR: '' });

    expect(status).toBe(0);
    expect(count(calls, 'sync')).toBe(0);
    expect(count(calls, 'start')).toBe(1);
  });

  it('#34 TORIFUNE_BUNDLED_PLUGINS_DIR が未設定なら同期は呼ばれない（起動はする）', () => {
    const { status, calls } = runEntrypoint({ TORIFUNE_BUNDLED_PLUGINS_DIR: undefined });

    expect(status).toBe(0);
    expect(count(calls, 'sync')).toBe(0);
    expect(count(calls, 'start')).toBe(1);
  });

  it('#35 同期のスタブが終了コード 1 → bundled plugin sync FAILED の警告を標準エラーに出す', () => {
    flag('sync-fail');

    const { stderr, calls } = runEntrypoint();

    expect(count(calls, 'sync')).toBe(1);
    expect(stderr).toContain('bundled plugin sync FAILED');
  });

  it('#35 同期のスタブが終了コード 1 でも、起動コマンドは呼ばれ、entrypoint はその終了コードで終わる', () => {
    flag('sync-fail');

    const { status, calls } = runEntrypoint();

    expect(count(calls, 'start')).toBe(1);
    expect(status).toBe(0);
  });
});

describe.skipIf(!SH_AVAILABLE)('起動時の突き合わせ', () => {
  it('#36 いまの指紋と .next/torifune-plugin-sources が同じ → 指紋は計算するが、起動前にビルドしない', () => {
    const { status, calls } = runEntrypoint();

    expect(status).toBe(0);
    const before = beforeFirstStart(calls);
    expect(count(before, 'fingerprint')).toBeGreaterThanOrEqual(1);
    expect(count(calls, 'build')).toBe(0);
    expect(count(calls, 'start')).toBe(1);
  });

  it('#36 指紋が同じ → .next（BUILD_ID と指紋）は触られない', () => {
    runEntrypoint();

    expect(buildIdFile()).toBe(BAKED_BUILD_ID);
    expect(buildFingerprintFile()).toBe(FP_BAKED);
  });

  it('#37 指紋が違う → 起動前にビルドのスタブが 1 回呼ばれる', () => {
    setCurrentFingerprint(FP_CURRENT);

    const { status, calls } = runEntrypoint();

    expect(status).toBe(0);
    expect(count(beforeFirstStart(calls), 'build')).toBe(1);
    expect(count(calls, 'build')).toBe(1);
    expect(count(calls, 'start')).toBe(1);
    // 起動したときには新しいビルドになっている。
    expect(readTrimmed(file('seen-1'))?.split('\n')[0]).toBe('build-1');
  });

  it('#37 成功後の .next/torifune-plugin-sources は、ビルドの前に計算した値（ビルドの後の値ではない）', () => {
    setCurrentFingerprint(FP_CURRENT);

    runEntrypoint();

    expect(buildFingerprintFile()).toBe(FP_CURRENT);
    expect(buildFingerprintFile()).not.toBe(FP_AFTER_BUILD);
  });

  it('#37 指紋が違う → plugin sources differ from the build のログを出す', () => {
    setCurrentFingerprint(FP_CURRENT);

    const { stdout, stderr } = runEntrypoint();

    expect(`${stdout}${stderr}`).toContain('plugin sources differ from the build');
  });

  it('#38 .next/torifune-plugin-sources が無い → 起動前にビルドが 1 回呼ばれ、指紋が書かれる', () => {
    setBuildFingerprint(null);
    setCurrentFingerprint(FP_CURRENT);

    const { status, calls } = runEntrypoint();

    expect(status).toBe(0);
    expect(count(beforeFirstStart(calls), 'build')).toBe(1);
    expect(count(calls, 'build')).toBe(1);
    expect(buildFingerprintFile()).toBe(FP_CURRENT);
  });

  it('#39 指紋のスタブが失敗 → ビルドは呼ばれず、起動コマンドは呼ばれる', () => {
    setBuildFingerprint(FP_BAKED);
    flag('fp-fail');

    const { status, calls } = runEntrypoint();

    expect(status).toBe(0);
    expect(count(beforeFirstStart(calls), 'fingerprint')).toBeGreaterThanOrEqual(1);
    expect(count(calls, 'build')).toBe(0);
    expect(count(calls, 'start')).toBe(1);
  });

  it('#39 指紋のスタブが失敗 → could not fingerprint plugins の警告を標準エラーに出す', () => {
    flag('fp-fail');

    const { stderr } = runEntrypoint();

    expect(stderr).toContain('could not fingerprint plugins');
  });

  it('#40 sentinel があり、指紋も違う → ビルドは起動前に 1 回だけ', () => {
    writeFileSync(layout.sentinel, '', 'utf8');
    setCurrentFingerprint(FP_CURRENT);

    const { status, calls } = runEntrypoint();

    expect(status).toBe(0);
    expect(count(beforeFirstStart(calls), 'build')).toBe(1);
    expect(count(calls, 'build')).toBe(1);
    expect(count(calls, 'start')).toBe(1);
  });

  it('#40 sentinel があり、指紋も違う → sentinel は消え、指紋が書かれる', () => {
    writeFileSync(layout.sentinel, '', 'utf8');
    setCurrentFingerprint(FP_CURRENT);

    runEntrypoint();

    expect(existsSync(layout.sentinel)).toBe(false);
    expect(buildFingerprintFile()).toBe(FP_CURRENT);
  });

  it('#41 起動時のビルドが失敗 → ビルドは 1 回呼ばれ、.next が前の中身（BUILD_ID と前の指紋）に戻る', () => {
    setCurrentFingerprint(FP_CURRENT);
    flag('build-fail');

    const { calls } = runEntrypoint();

    expect(count(beforeFirstStart(calls), 'build')).toBe(1);
    expect(buildIdFile()).toBe(BAKED_BUILD_ID);
    expect(buildFingerprintFile()).toBe(FP_BAKED);
    expect(existsSync(join(layout.nextDir, 'BROKEN'))).toBe(false);
  });

  it('#41 起動時のビルドが失敗 → rebuild FAILED を出し、起動コマンドは前のビルドで呼ばれる', () => {
    setCurrentFingerprint(FP_CURRENT);
    flag('build-fail');

    const { status, stderr, calls } = runEntrypoint();

    expect(status).toBe(0);
    expect(count(calls, 'build')).toBe(1);
    expect(count(calls, 'start')).toBe(1);
    expect(stderr).toContain('rebuild FAILED');
    expect(readTrimmed(file('seen-1'))?.split('\n')).toEqual([BAKED_BUILD_ID, FP_BAKED]);
  });
});

describe.skipIf(!SH_AVAILABLE)('監視ループの再ビルド', () => {
  it('#42 起動コマンドが sentinel を書いて 75 で終わる → 指紋が同じでも必ずビルドを呼び、起動し直す', () => {
    // いまの指紋は .next の指紋と同じのまま（起動前の再ビルドは無い）。
    onStart(1, `touch '${toShellPath(layout.sentinel)}'\nexit 75`);

    const { status, calls } = runEntrypoint();

    expect(status).toBe(0);
    expect(count(beforeFirstStart(calls), 'build')).toBe(0);
    expect(calls.filter((line) => ['build', 'start'].includes(kind(line)))).toEqual([
      'start',
      'build',
      'start',
    ]);
  });

  it('#42 監視ループの再ビルドが成功 → ビルドの前に計算した指紋を .next に書く', () => {
    // 導入でソースが変わった（起動の後に Volume が変わる）。
    onStart(
      1,
      [
        `printf '%s\\n' '${FP_CHANGED_IN_LOOP}' > '${toShellPath(file('fp-current'))}'`,
        `touch '${toShellPath(layout.sentinel)}'`,
        'exit 75',
      ].join('\n'),
    );

    const { status, calls } = runEntrypoint();

    expect(status).toBe(0);
    expect(count(calls, 'build')).toBe(1);
    expect(buildIdFile()).toBe('build-1');
    expect(buildFingerprintFile()).toBe(FP_CHANGED_IN_LOOP);
  });

  it('#42 監視ループの再ビルドが失敗 → .next が前の中身に戻り、前の指紋が残る', () => {
    flag('build-fail');
    onStart(
      1,
      [
        `printf '%s\\n' '${FP_CHANGED_IN_LOOP}' > '${toShellPath(file('fp-current'))}'`,
        `touch '${toShellPath(layout.sentinel)}'`,
        'exit 75',
      ].join('\n'),
    );

    const { status, calls } = runEntrypoint();

    expect(status).toBe(0);
    expect(count(calls, 'build')).toBe(1);
    expect(count(calls, 'start')).toBe(2);
    expect(buildIdFile()).toBe(BAKED_BUILD_ID);
    expect(buildFingerprintFile()).toBe(FP_BAKED);
    expect(existsSync(join(layout.nextDir, 'BROKEN'))).toBe(false);
  });
});
