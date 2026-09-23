import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `rotatedCredential` の書き戻しの静的検査（039-social-credential-fields 設計 §6.1、受け入れ条件 #65）。
 *
 * * 資格情報の書き戻しは比較更新（`replaceCredentialIfUnchanged`）だけで行う。
 *   `publish.ts` から `socialRepository.updateAccount(`（`WHERE id = ?` だけの上書き）を呼ばない
 * * 版（`credentialVersion`＝保存されている暗号文）は Domain の型・Repository・`publish.ts` の中だけで持ち回る。
 *   `ui/` / `app/` / `api/` / `plugin/` に出さない（ログ・監査・Plugin へ渡さない。設計 §6.1 の 2）
 * * `publish()` に渡す `PublishInput` に版を入れない（`035` §6.5.5 の「渡す形」を変えない。設計 §6.1 の 3）
 *
 * 「無いこと」を見る検査は実装が無いうちは素通りしうるので、述語の判別力を同じファイルで確かめる
 * （禁止の綴りを 1 つ足した `publish.ts` の写しを見分ける。実装プラン §2「静的検査（#65）」）。
 */

/** apps/web/src/application/social → apps/web/src */
const SRC_DIR = join(import.meta.dirname, '..', '..');
const PUBLISH_TS = join(SRC_DIR, 'application', 'social', 'publish.ts');

/** `credentialVersion` が現れてよい本体のファイル（`apps/web/src` からの相対パス）。テストは別に許す。 */
const VERSION_ALLOWED = [
  'domain/social/social.ts',
  'domain/social/social-repository.ts',
  'infrastructure/social-repository.ts',
  'application/social/publish.ts',
] as const;

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

/** ディレクトリ以下のすべての `.ts` / `.tsx`（テストを除く）。`apps/web/src` からの相対パス（`/` 区切り）で返す。 */
function sourceFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFilesUnder(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(relative(SRC_DIR, path).split(sep).join('/'));
    }
  }
  return found;
}

/** `socialRepository.updateAccount(` の呼び出しがあるか（コメントを除く。空白を挟んだ書き方も拾う）。 */
function callsUpdateAccount(source: string): boolean {
  return /socialRepository\s*\.\s*updateAccount\s*\(/.test(withoutComments(source));
}

/** `credentialVersion` が現れる本体のファイルのうち、許した 4 つ以外のもの。 */
function versionLeaks(files: readonly { path: string; text: string }[]): string[] {
  return files
    .filter(({ text }) => text.includes('credentialVersion'))
    .map(({ path }) => path)
    .filter((path) => !(VERSION_ALLOWED as readonly string[]).includes(path));
}

/**
 * `const publishInput: PublishInput = { … };` のオブジェクトリテラルの中身（コメントを除く）。
 * 見つからなければ null（呼び出し側で落とす）。
 */
function publishInputLiteral(source: string): string | null {
  const code = withoutComments(source);
  const start = code.search(/const\s+publishInput\s*:\s*PublishInput\s*=\s*\{/);
  if (start === -1) return null;
  const open = code.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open, index + 1);
    }
  }
  return null;
}

/** `PublishInput` のリテラルに版（`version` / `credentialVersion`）があるか。 */
function publishInputCarriesVersion(literal: string): boolean {
  return /\b(?:credentialVersion|version)\b/i.test(literal);
}

describe('#65 publish.ts は資格情報を updateAccount で書き戻さない', () => {
  const source = readFileSync(PUBLISH_TS, 'utf8');

  it('#65 publish.ts に socialRepository.updateAccount( の呼び出しが無い', () => {
    expect(callsUpdateAccount(source)).toBe(false);
  });

  it('#65 publish.ts は replaceCredentialIfUnchanged を呼ぶ（書き戻しの口がこれだけになった）', () => {
    expect(withoutComments(source)).toMatch(/\.\s*replaceCredentialIfUnchanged\s*\(/);
  });
});

describe('#65 credentialVersion が現れる場所', () => {
  const files = sourceFilesUnder(SRC_DIR).map((path) => ({
    path,
    text: readFileSync(join(SRC_DIR, path), 'utf8'),
  }));

  it('#65 本体（テストを除く）で credentialVersion が現れるのは設計が挙げた 4 ファイルだけ', () => {
    expect(versionLeaks(files)).toEqual([]);
  });

  it.each(['ui/', 'app/', 'api/', 'plugin/'])(
    '#65 %s に credentialVersion が現れない',
    (prefix) => {
      expect(
        files.filter(
          ({ path, text }) => path.startsWith(prefix) && text.includes('credentialVersion'),
        ),
      ).toEqual([]);
    },
  );

  it.each([
    'domain/social/social.ts',
    'infrastructure/social-repository.ts',
    'application/social/publish.ts',
  ])('#65 %s に credentialVersion が現れる（検査が空振りしていない）', (path) => {
    expect(files.find((file) => file.path === path)?.text ?? '').toContain('credentialVersion');
  });
});

describe('#65 PublishInput を組む箇所に版が無い', () => {
  const source = readFileSync(PUBLISH_TS, 'utf8');

  it('#65 publish.ts に const publishInput: PublishInput = { … } がある（検査が空振りしていない）', () => {
    expect(publishInputLiteral(source)).not.toBeNull();
  });

  it('#65 そのリテラルに version / credentialVersion が無い', () => {
    expect(publishInputCarriesVersion(publishInputLiteral(source) ?? '')).toBe(false);
  });
});

describe('#65 検査の述語の判別力', () => {
  const source = readFileSync(PUBLISH_TS, 'utf8');

  it('#65 updateAccount の呼び出しを 1 つ足した写しを見分ける', () => {
    const mutated = `${source}\nawait socialRepository.updateAccount(tx, accountId, { encryptedCredential });\n`;

    expect(callsUpdateAccount(mutated)).toBe(true);
  });

  it('#65 改行や空白を挟んだ updateAccount の呼び出しも見分ける', () => {
    expect(callsUpdateAccount('socialRepository\n  .updateAccount (tx, id, patch)')).toBe(true);
  });

  it('#65 コメントの中の updateAccount は数えない', () => {
    expect(
      callsUpdateAccount(
        '// socialRepository.updateAccount( は使わない\n/* socialRepository.updateAccount( */',
      ),
    ).toBe(false);
  });

  it('#65 PublishInput に版を 1 つ足した写しを見分ける', () => {
    const mutated = source.replace(
      /const\s+publishInput\s*:\s*PublishInput\s*=\s*\{/,
      (head) => `${head}\n    version: resolved.version,`,
    );

    expect(mutated).not.toBe(source);
    expect(publishInputCarriesVersion(publishInputLiteral(mutated) ?? '')).toBe(true);
  });

  it('#65 PublishInput に credentialVersion を足した写しも見分ける', () => {
    expect(
      publishInputCarriesVersion('{ post, credentialVersion: withCredential.credentialVersion }'),
    ).toBe(true);
  });

  it('#65 ui/ に credentialVersion を置いた写しを見分ける', () => {
    expect(
      versionLeaks([
        { path: 'domain/social/social.ts', text: 'readonly credentialVersion: string | null;' },
        { path: 'ui/social/social-accounts.tsx', text: 'const v = account.credentialVersion;' },
      ]),
    ).toEqual(['ui/social/social-accounts.tsx']);
  });
});
