import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `CampaignInput.siteIds` / `socialPostIds` の TSDoc と Plugin 開発ガイドの静的検査
 * （045-campaign-input-500 設計 §9.3・§12、受け入れ条件 #35）。
 *
 * - `packages/plugin-api/src/data.ts` の `CampaignInput` の `siteIds` と `socialPostIds` の直前の TSDoc が、
 *   それぞれ上限の `1000` と reject の `ValidationError` を書いている
 * - `docs/Plugin開発ガイド.md` §4 が作成・更新の `siteIds` の規則（UUID の形・存在・1000 件・`ValidationError`）を書いている
 *
 * ファイルを読むだけで、何も実行しない（`plugin-api-docs-static-checks.test.ts` の切り出し方を写した）。
 * `packages/plugin-api` にテストを足さないので、ここ（本体側）に置く。
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const DATA_TS = join(REPO_ROOT, 'packages', 'plugin-api', 'src', 'data.ts');
const GUIDE = join(REPO_ROOT, 'docs', 'Plugin開発ガイド.md');

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

/** `export interface CampaignInput` の中の `readonly <field>` の直前の TSDoc。 */
function campaignInputFieldDoc(field: 'siteIds' | 'socialPostIds'): string {
  const source = read(DATA_TS);
  const declaration = indexAfter(source, 'export interface CampaignInput');
  const fieldIndex = indexAfter(source, `readonly ${field}?`, declaration);
  return docCommentBefore(source, fieldIndex);
}

/** ガイド §4（`## 4.` から `## 5.` の手前まで）。 */
function guideDataSection(): string {
  const source = read(GUIDE);
  const from = indexAfter(source, '\n## 4.');
  return source.slice(from, indexAfter(source, '\n## 5.', from + 1));
}

const FIELDS = ['siteIds', 'socialPostIds'] as const;

describe('#35 CampaignInput の siteIds / socialPostIds の TSDoc が規則を書いている', () => {
  it.each(FIELDS)('#35 CampaignInput.%s の TSDoc が 1000 を含む', (field) => {
    expect(campaignInputFieldDoc(field)).toContain('1000');
  });

  it.each(FIELDS)('#35 CampaignInput.%s の TSDoc が ValidationError を含む', (field) => {
    expect(campaignInputFieldDoc(field)).toContain('ValidationError');
  });

  it.each(FIELDS)('#35 CampaignInput.%s の TSDoc が UUID を含む', (field) => {
    expect(campaignInputFieldDoc(field)).toContain('UUID');
  });
});

describe('#35 Plugin開発ガイド §4 が作成・更新の siteIds の規則を書いている', () => {
  it('#35 §4 が siteIds を含む', () => {
    expect(guideDataSection()).toContain('siteIds');
  });

  it('#35 §4 が 1000 を含む', () => {
    expect(guideDataSection()).toContain('1000');
  });

  it('#35 §4 が ValidationError を含む', () => {
    expect(guideDataSection()).toContain('ValidationError');
  });

  it('#35 §4 が campaigns.create を含む（作成・更新の引数として書いている）', () => {
    expect(guideDataSection()).toContain('campaigns.create');
  });
});

describe('#35 の切り出しが対象を捉えている', () => {
  it('ガイド §4 の切り出しに Data API の例（data.sites.list）が入っている', () => {
    expect(guideDataSection()).toContain('data.sites.list');
  });

  it('CampaignInput の切り出しは interface の中の項目を指している（startsOn の後ろにある）', () => {
    const source = read(DATA_TS);
    const declaration = indexAfter(source, 'export interface CampaignInput');
    const startsOn = indexAfter(source, 'readonly startsOn', declaration);

    expect(indexAfter(source, 'readonly siteIds?', declaration)).toBeGreaterThan(startsOn);
  });
});
