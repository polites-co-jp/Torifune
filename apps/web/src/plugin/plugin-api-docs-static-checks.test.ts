import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 公開 Plugin API の TSDoc と Plugin 開発ガイドの静的検査（043-api-input-fixes-rest 設計 §9.3・§9.4・§12、
 * 受け入れ条件 #46・#47）。
 *
 * - #46：`ManualHandoff.url` の TSDoc と、ガイド §9「SNS 配信（`social`）」が URL の上限 `2048` を書いている
 * - #47：`ListOptions` の TSDoc が丸めの規則（1〜100）を、`socialPosts.list` / `campaigns.list` の TSDoc が
 *   `PluginDataInputError` を書いている。ガイド §4 が `PluginDataInputError` と丸めの規則を書いている
 *
 * ファイルを読むだけで、何も実行しない。TSDoc は対象の宣言の**直前の `/** … *\/`** を切り出して見る
 * （`ListOptions` は中の項目の TSDoc も、`list` は引数の型の中の TSDoc も含める）。
 * ガイドは節を切り出して見る（§4 は `## 4.` から `## 5.` の手前、§9 の SNS 配信は `### SNS 配信（`social`）` から `## 10.` の手前）。
 *
 * `packages/plugin-api` にテストを足さない（#49）ので、ここ（本体側）に置く（実装プラン §8 の 5・10）。
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const DATA_TS = join(REPO_ROOT, 'packages', 'plugin-api', 'src', 'data.ts');
const SOCIAL_TS = join(REPO_ROOT, 'packages', 'plugin-api', 'src', 'social.ts');
const GUIDE = join(REPO_ROOT, 'docs', 'Plugin開発ガイド.md');

/** 「1〜100」（波ダッシュ・全角チルダ・ハイフンのいずれでもよい）。 */
const ONE_TO_HUNDRED = /1\s*[〜～~-]\s*100/;

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

/** `from` から、同じ深さで閉じる `}` までの中身（`{` の直後から）。 */
function blockFrom(source: string, openBraceIndex: number): string {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex + 1, index);
    }
  }
  throw new Error('ブロックが閉じていない');
}

/** `export interface ListOptions` の TSDoc と、中の項目の TSDoc。 */
function listOptionsDoc(): string {
  const source = read(DATA_TS);
  const declaration = indexAfter(source, 'export interface ListOptions');
  const body = blockFrom(source, indexAfter(source, '{', declaration));
  return `${docCommentBefore(source, declaration)}\n${body}`;
}

/** `readonly <group>: {` の中の `list(` の TSDoc と、その引数の型（`Promise<` の手前まで）。 */
function listDoc(group: 'socialPosts' | 'campaigns'): string {
  const source = read(DATA_TS);
  const groupIndex = indexAfter(source, `readonly ${group}: {`);
  const listIndex = indexAfter(source, 'list(', groupIndex);
  const signatureEnd = indexAfter(source, 'Promise<', listIndex);
  return `${docCommentBefore(source, listIndex)}\n${source.slice(listIndex, signatureEnd)}`;
}

/** `ManualHandoff.url` の TSDoc。 */
function manualUrlDoc(): string {
  const source = read(SOCIAL_TS);
  const declaration = indexAfter(source, 'export interface ManualHandoff');
  const urlIndex = indexAfter(source, 'readonly url', declaration);
  return docCommentBefore(source, urlIndex);
}

/** ガイドの `start` から `end` の手前まで。 */
function guideSection(start: string, end: string): string {
  const source = read(GUIDE);
  const from = indexAfter(source, start);
  return source.slice(from, indexAfter(source, end, from + start.length));
}

function guideDataSection(): string {
  return guideSection('\n## 4.', '\n## 5.');
}

function guideSocialSection(): string {
  return guideSection('\n### SNS 配信（`social`）', '\n## 10.');
}

/* -------------------------------------------------------------------------- */
/* #46 ManualHandoff.url の上限                                                  */
/* -------------------------------------------------------------------------- */

describe('#46 ManualHandoff.url の上限 2048 文字が書かれている', () => {
  it('#46 packages/plugin-api/src/social.ts の ManualHandoff.url の TSDoc が 2048 を含む', () => {
    expect(manualUrlDoc()).toContain('2048');
  });

  it('#46 Plugin開発ガイド §9「SNS 配信（social）」が 2048 を含む', () => {
    expect(guideSocialSection()).toContain('2048');
  });
});

/* -------------------------------------------------------------------------- */
/* #47 Data API の一覧の規則                                                      */
/* -------------------------------------------------------------------------- */

describe('#47 ListOptions の TSDoc が丸めの規則を書いている', () => {
  it('#47 ListOptions の TSDoc が 1〜100 を含む', () => {
    expect(listOptionsDoc()).toMatch(ONE_TO_HUNDRED);
  });

  it('#47 ListOptions の TSDoc が「丸め」を含む', () => {
    expect(listOptionsDoc()).toContain('丸め');
  });
});

describe('#47 socialPosts.list / campaigns.list の TSDoc が PluginDataInputError を書いている', () => {
  it.each(['socialPosts', 'campaigns'] as const)(
    '#47 %s.list の TSDoc が PluginDataInputError を含む',
    (group) => {
      expect(listDoc(group)).toContain('PluginDataInputError');
    },
  );
});

describe('#47 Plugin開発ガイド §4 が PluginDataInputError と丸めの規則を書いている', () => {
  it('#47 §4 が PluginDataInputError を含む', () => {
    expect(guideDataSection()).toContain('PluginDataInputError');
  });

  it('#47 §4 が 1〜100 を含む', () => {
    expect(guideDataSection()).toMatch(ONE_TO_HUNDRED);
  });

  it('#47 §4 が「丸め」を含む', () => {
    expect(guideDataSection()).toContain('丸め');
  });
});

/* -------------------------------------------------------------------------- */
/* 切り出しが空回りしていないこと                                                    */
/* -------------------------------------------------------------------------- */

describe('#46・#47 の切り出しが対象を捉えている', () => {
  it('ガイド §4 の切り出しに Data API の例（data.sites.list）が入っている', () => {
    expect(guideDataSection()).toContain('data.sites.list');
  });

  it('ガイド §9 の SNS 配信の切り出しに manual の説明が入っている', () => {
    expect(guideSocialSection()).toContain('manual');
  });

  it('ManualHandoff.url の切り出しに既存の説明（https の絶対 URL）が入っている', () => {
    expect(manualUrlDoc()).toContain('https の絶対 URL');
  });

  it('ListOptions の切り出しに項目 perPage が入っている', () => {
    expect(listOptionsDoc()).toContain('perPage');
  });

  it.each(['socialPosts', 'campaigns'] as const)(
    '%s.list の切り出しに引数の型（ListOptions）が入っている',
    (group) => {
      expect(listDoc(group)).toContain('ListOptions');
    },
  );
});
