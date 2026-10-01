import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * 生成スクリプトの隔離マークの見方（050-bundled-plugin-sync 設計 §6.7.1・§13 R8）。
 *
 * 起動時の指紋（`packages/cli/src/plugins/tree-hash.ts`）と生成スクリプト（`scripts/generate-plugin-registry.mjs`）は
 * **同じ範囲**を見なければならない。ずれると、指紋が「隔離されている」として除いた Plugin を生成スクリプトが
 * ビルドに入れる（または逆）。指紋は隔離マークを**辿らずに**（`lstat`）、何かの項目としてあれば隔離とみなす。
 * 生成スクリプトも同じく、リンク先の無いシンボリックリンクの隔離マークを「隔離されている」と読むこと。
 *
 * 生成スクリプトはリポジトリの位置（`<script>/../plugins`）から読み、`<script>/../apps/web/src/plugin/` へ書くので、
 * 一時ディレクトリに同じ形を作ってスクリプトの写しを動かす（リポジトリの生成物には触れない）。
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const GENERATOR = join(REPO_ROOT, 'scripts', 'generate-plugin-registry.mjs');

/** シンボリックリンクを作れるか（`tree-hash.test.ts` と同じ。作れない環境ではその件だけを飛ばす）。 */
function probeFileLink(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'torifune-gen-probe-'));
  try {
    writeFileSync(join(probe, 'target.txt'), 'x');
    symlinkSync('target.txt', join(probe, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

const CAN_LINK_FILE = probeFileLink();
if (!CAN_LINK_FILE) {
  console.warn(
    '[generate-plugin-registry-quarantine.test] この環境ではシンボリックリンクを作れないため、リンクの隔離マークの件を飛ばす',
  );
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'torifune-gen-'));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(GENERATOR, join(root, 'scripts', 'generate-plugin-registry.mjs'));
  writePlugin('alpha');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writePlugin(id: string): string {
  const dir = join(root, 'plugins', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0' }));
  writeFileSync(join(dir, 'index.ts'), 'export default {};\n');
  return dir;
}

/** 写したスクリプトを動かし、生成されたレジストリの directory の一覧を返す。 */
function generatedDirectories(): readonly string[] {
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'generate-plugin-registry.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const registry = readFileSync(
    join(root, 'apps', 'web', 'src', 'plugin', 'generated-registry.ts'),
    'utf8',
  );
  return [...registry.matchAll(/directory: "([^"]+)"/g)].map((match) => match[1] as string);
}

describe('生成スクリプトの隔離マーク', () => {
  it('隔離マーク（通常のファイル）のある Plugin はレジストリに入れない', () => {
    const broken = writePlugin('broken');
    writeFileSync(join(broken, '.torifune-quarantine'), 'build failed');

    expect(generatedDirectories()).toEqual(['alpha']);
  });

  it.skipIf(!CAN_LINK_FILE)(
    'リンク先の無いシンボリックリンクの隔離マークも「隔離されている」として、レジストリに入れない（指紋と同じ見方）',
    () => {
      const broken = writePlugin('broken');
      symlinkSync('no-such-target', join(broken, '.torifune-quarantine'), 'file');

      expect(generatedDirectories()).toEqual(['alpha']);
    },
  );
});
