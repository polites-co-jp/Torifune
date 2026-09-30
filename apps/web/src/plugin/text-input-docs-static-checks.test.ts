import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 文字の規則と範囲の TSDoc・文書の静的検査（046-input-500-nul-and-ranges 設計 §9.5・§12、受け入れ条件 #54）。
 *
 * - `packages/plugin-api/src/store.ts`：`PluginStore.set` の TSDoc が `NUL`・`サロゲート`・`PluginStoreError` を、
 *   `keys` の TSDoc が `NUL` を含む
 * - `packages/plugin-api/src/data.ts`：`PluginDataApi` の冒頭の TSDoc が `NUL`・`サロゲート`・`ValidationError` を含む
 * - `packages/plugin-api/src/social.ts`：`PublishResult` の `reason` の TSDoc が `U+FFFD` を含む
 * - `docs/Plugin開発ガイド.md`：§4 が `NUL`・`サロゲート`・`ValidationError`、§5 が `NUL` と `PluginStoreError` を含む
 * - `docs/マニュアル/SNS投稿API仕様.md`：§1.3 が `NUL`・`サロゲート`・`422`、§1.4 が `0001-01-01T00:00:00Z` と `9999-12-31T23:59:59.999Z` を含む
 *
 * ファイルを読むだけで、何も実行しない（`campaign-link-docs-static-checks.test.ts` の切り出し方を写した）。
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const STORE_TS = join(REPO_ROOT, 'packages', 'plugin-api', 'src', 'store.ts');
const DATA_TS = join(REPO_ROOT, 'packages', 'plugin-api', 'src', 'data.ts');
const SOCIAL_TS = join(REPO_ROOT, 'packages', 'plugin-api', 'src', 'social.ts');
const GUIDE = join(REPO_ROOT, 'docs', 'Plugin開発ガイド.md');
const SNS_API = join(REPO_ROOT, 'docs', 'マニュアル', 'SNS投稿API仕様.md');

function read(path: string): string {
  return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
}

/** `from` の位置から後ろで最初に `marker` が現れる位置。無ければテストを落とす。 */
function indexAfter(source: string, marker: string, from = 0): number {
  const index = source.indexOf(marker, from);
  if (index < 0) throw new Error(`見つからない: ${marker}`);
  return index;
}

/** `index` の直前（空白だけを挟む）にある `/** … *\/`。無ければ空文字。 */
function docCommentBefore(source: string, index: number): string {
  const before = source.slice(0, index).trimEnd();
  if (!before.endsWith('*/')) {
    return '';
  }
  const start = before.lastIndexOf('/**');
  return start < 0 ? '' : before.slice(start);
}

/** `export interface PluginStore` の中の `<member>` の直前の TSDoc。 */
function storeMemberDoc(member: 'set<' | 'keys('): string {
  const source = read(STORE_TS);
  const declaration = indexAfter(source, 'export interface PluginStore');
  return docCommentBefore(source, indexAfter(source, `  ${member}`, declaration));
}

/** `export interface PluginDataApi` の直前の TSDoc。 */
function dataApiDoc(): string {
  const source = read(DATA_TS);
  return docCommentBefore(source, indexAfter(source, 'export interface PluginDataApi'));
}

/** `export type PublishResult` の中の `readonly reason` の直前の TSDoc。 */
function publishResultReasonDoc(): string {
  const source = read(SOCIAL_TS);
  const declaration = indexAfter(source, 'export type PublishResult');
  return docCommentBefore(source, indexAfter(source, 'readonly reason', declaration));
}

/** `start` の見出しから `end` の見出しの手前まで。 */
function section(path: string, start: string, end: string): string {
  const source = read(path);
  const from = indexAfter(source, start);
  return source.slice(from, indexAfter(source, end, from + 1));
}

function guideSection4(): string {
  return section(GUIDE, '\n## 4.', '\n## 5.');
}

function guideSection5(): string {
  return section(GUIDE, '\n## 5.', '\n## 6.');
}

function snsSection13(): string {
  return section(SNS_API, '\n### 1.3', '\n### 1.4');
}

function snsSection14(): string {
  return section(SNS_API, '\n### 1.4', '\n## 2.');
}

describe('#54 PluginStore の TSDoc', () => {
  it.each(['NUL', 'サロゲート', 'PluginStoreError'])(
    '#54 PluginStore.set の TSDoc が %s を含む',
    (word) => {
      expect(storeMemberDoc('set<')).toContain(word);
    },
  );

  it('#54 PluginStore.keys の TSDoc が NUL を含む', () => {
    expect(storeMemberDoc('keys(')).toContain('NUL');
  });
});

describe('#54 PluginDataApi の冒頭の TSDoc', () => {
  it.each(['NUL', 'サロゲート', 'ValidationError'])(
    '#54 PluginDataApi の TSDoc が %s を含む',
    (word) => {
      expect(dataApiDoc()).toContain(word);
    },
  );
});

describe('#54 PublishResult の reason の TSDoc', () => {
  it('#54 PublishResult の reason の TSDoc が U+FFFD を含む', () => {
    expect(publishResultReasonDoc()).toContain('U+FFFD');
  });
});

describe('#54 Plugin開発ガイド', () => {
  it.each(['NUL', 'サロゲート', 'ValidationError'])('#54 §4 が %s を含む', (word) => {
    expect(guideSection4()).toContain(word);
  });

  it.each(['NUL', 'PluginStoreError'])('#54 §5 が %s を含む', (word) => {
    expect(guideSection5()).toContain(word);
  });
});

describe('#54 SNS投稿API仕様', () => {
  it.each(['NUL', 'サロゲート', '422'])('#54 §1.3 が %s を含む', (word) => {
    expect(snsSection13()).toContain(word);
  });

  it.each(['0001-01-01T00:00:00Z', '9999-12-31T23:59:59.999Z'])('#54 §1.4 が %s を含む', (word) => {
    expect(snsSection14()).toContain(word);
  });
});

describe('#54 の切り出しが対象を捉えている', () => {
  it('PluginStore.set の切り出しは interface の中の set を指している（get の後ろにある）', () => {
    const source = read(STORE_TS);
    const declaration = indexAfter(source, 'export interface PluginStore');

    expect(indexAfter(source, '  set<', declaration)).toBeGreaterThan(
      indexAfter(source, '  get<', declaration),
    );
  });

  it('ガイド §4 の切り出しに Data API の例（data.sites.list）が入っている', () => {
    expect(guideSection4()).toContain('data.sites.list');
  });

  it('ガイド §5 の切り出しに Store の説明（store.set）が入っている', () => {
    expect(guideSection5()).toContain('store.set');
  });

  it('SNS投稿API仕様 §1.3 の切り出しが「文字コード」の節を指している', () => {
    expect(snsSection13()).toContain('文字コード');
  });

  it('SNS投稿API仕様 §1.4 の切り出しが「時刻の形式」の節を指している', () => {
    expect(snsSection14()).toContain('時刻の形式');
  });
});
