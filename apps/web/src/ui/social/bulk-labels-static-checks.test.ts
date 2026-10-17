import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BULK_EFFECTS, BULK_FAILURE_REASONS } from '@/domain/social/bulk';
import * as labels from './labels';

/**
 * 054 の文言・ページ送り・設定 → API の静的検査（054-bulk-post-actions 設計 §9.2・§9.9・§9.10、
 * 受け入れ条件 #60、#76 の部品側）。
 *
 * * #60：`BULK_REASON_LABEL` のキーが `BULK_FAILURE_REASONS` と、`BULK_EFFECT_LABEL` のキーが `BULK_EFFECTS` と
 *   ちょうど一致する。設計 §9.10 の文言が `social-posts.tsx` に直書きされていない（`labels.ts` にある）
 * * #76：`social-posts.tsx` のページ送りが `'/social?postPage='` を書かず、`openPostListPage` を呼ぶ。
 *   絞り込みの帯は `postListHref` で URL を作る（設計 §9.2）
 * * 設定 → API：`api-settings.tsx` が `API_TOKEN_NAME_SOURCE_NOTE` を使い、§9.9 の文を直書きしない
 * * 一括の純関数のモジュール `bulk-plan.ts` は Client Component のモジュールにしない（実装プラン T25）。
 *   取り消しの対象は Domain の `BULK_DELETABLE_STATUSES` で決める（設計 §9.6）
 *
 * 述語（`stripComments`・`isHardCoded`・`isHardCodedShort`・`importsFrom`）は
 * `site-scope-labels-static-checks.test.ts` #72 を**写す**（テストファイルを import しない）。判別力の件も同じ形で置く。
 * `labels.ts` の新しい定数はまだ無いので、名前で引く（`import * as`）。
 */

const UI_DIR = join(import.meta.dirname, '..');

const POSTS_COMPONENT = join(UI_DIR, 'social', 'social-posts.tsx');
const SOCIAL_LABELS = join(UI_DIR, 'social', 'labels.ts');
const BULK_PLAN = join(UI_DIR, 'social', 'bulk-plan.ts');
const SETTINGS_COMPONENT = join(UI_DIR, 'settings', 'api-settings.tsx');

/** 無いファイルは空として読む（「ある」の検査が赤になり、「直書きしない」の検査は素通りしない）。 */
function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `/* … *\/`（JSX の `{/* … *\/}` を含む）と `// …` を外す。`https://` のような `:` の後は外さない。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 文言が文字列リテラルか JSX のテキストとして現れるか。 */
function isHardCoded(text: string, word: string): boolean {
  return stripComments(text).includes(word);
}

/** 短い語が、引用符で囲まれた形か JSX のテキストちょうどの形で現れるか。 */
function isHardCodedShort(text: string, word: string): boolean {
  const escaped = escapeRegExp(word);
  const quoted = new RegExp(`(['"\`])${escaped}\\1`);
  const jsxText = new RegExp(`>\\s*${escaped}\\s*<`);
  const code = stripComments(text);
  return quoted.test(code) || jsxText.test(code);
}

/** `import … from 'specifier'`（値の import。`import type` は数えない）。 */
function importsFrom(text: string, specifier: string): boolean {
  const pattern = new RegExp(
    `import\\s+(?!type\\s)[^;]*?from\\s*(['"])${escapeRegExp(specifier)}\\1`,
  );
  return pattern.test(stripComments(text));
}

/** 名前が識別子として現れるか（コメントの外）。 */
function mentions(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(stripComments(text));
}

/** 名前の関数を呼んでいるか（コメントの外）。 */
function calls(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*\\(`).test(stripComments(text));
}

function labelValue(name: string): unknown {
  return (labels as unknown as Record<string, unknown>)[name];
}

function keysOf(value: unknown): string[] {
  return value !== null && typeof value === 'object' ? Object.keys(value).sort() : [];
}

/* -------------------------------------------------------------------------- */
/* 文言（設計 §9.1〜§9.10）                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `social-posts.tsx` に直書きしない文言のうち、部分文字列で見て誤って当たらない長さのもの。
 * 字面は設計 §9.1・§9.3・§9.5〜§9.7・§9.10 と実装プラン §8 の 17 にあるもの。
 */
const POSTS_WORDS = [
  'このページの投稿をすべて選択',
  'この投稿を選択',
  '件を選択中',
  '（失効）',
  '（削除済み）',
  '削除されたトークン',
  '（発行',
  '条件に合う投稿がありません。',
  '一括送信（承認）',
  'それぞれの希望日時に投稿',
  '投稿を一括で取り消しますか？',
  'キャンペーンとの紐づけも削除されます。',
  '一括操作の結果',
  '処理されなかった投稿は、絞り込みで探して選び直せます。',
  '希望日時を過ぎています',
  '内容が変わっています。読み込み直してから操作してください',
  '時間内に処理できませんでした',
  '要求が失敗しました',
] as const;

/**
 * 短い語（見出し・選択肢・ボタンの見える文字）。引用符で囲んだ形か JSX のテキストちょうどの形で見る。
 * 「状態」「アカウント」は 054 の前から列の見出しとして `social-posts.tsx` に書かれているので数えない
 * （実装プラン §8 の 53）。
 */
const POSTS_SHORT_WORDS = [
  '登録元',
  '管理画面',
  '表示件数',
  'すべて',
  '条件をクリア',
  '一括取り消し',
  '送る',
] as const;

/** `labels.ts` にあるべき文言（設計 §9.10 が字面を決めているもの）。 */
const LABEL_WORDS = [
  '一括送信（承認）',
  'それぞれの希望日時に投稿',
  '投稿を一括で取り消しますか？',
  '一括操作の結果',
  '希望日時を過ぎています',
  '内容が変わっています。読み込み直してから操作してください',
  '時間内に処理できませんでした',
] as const;

const LABEL_SHORT_WORDS = ['一括取り消し', '送る'] as const;

/** 設定 → API の「名前」の説明に足す文（設計 §9.9）。 */
const API_TOKEN_NAME_SOURCE_NOTE_TEXT =
  'この名前は、SNS 画面の投稿一覧に『登録元』として表示されます（SNS の閲覧権限を持つ人に見えます）。外部アプリが分かる名前にしてください。';

/** 「名前」の説明の今の文（設計 §9.9「他は変えない」。実装プラン T27）。 */
const API_TOKEN_NAME_DESCRIPTION = 'どこで使うトークンかが分かる名前を付けます。';

/* -------------------------------------------------------------------------- */
/* 前提                                                                         */
/* -------------------------------------------------------------------------- */

describe('#60 前提：検査する部品がある（空振りしない）', () => {
  it.each([
    ['ui/social/social-posts.tsx', POSTS_COMPONENT],
    ['ui/social/labels.ts', SOCIAL_LABELS],
    ['ui/settings/api-settings.tsx', SETTINGS_COMPONENT],
  ])('#60 %s がある', (_name, path) => {
    expect(existsSync(path)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #60 BULK_REASON_LABEL / BULK_EFFECT_LABEL のキー                              */
/* -------------------------------------------------------------------------- */

describe('#60 理由と効果の表示名のキーが Domain の定数とちょうど一致する', () => {
  it('#60 BULK_REASON_LABEL のキーが BULK_FAILURE_REASONS とちょうど一致する', () => {
    expect(keysOf(labelValue('BULK_REASON_LABEL'))).toEqual([...BULK_FAILURE_REASONS].sort());
  });

  it('#60 BULK_EFFECT_LABEL のキーが BULK_EFFECTS とちょうど一致する', () => {
    expect(keysOf(labelValue('BULK_EFFECT_LABEL'))).toEqual([...BULK_EFFECTS].sort());
  });

  it('#60 BULK_REASON_LABEL の値はどれも空でない文字列', () => {
    const value = labelValue('BULK_REASON_LABEL') as Record<string, unknown> | undefined;

    expect(value, 'BULK_REASON_LABEL').toBeDefined();
    for (const reason of BULK_FAILURE_REASONS) {
      expect(typeof value?.[reason], reason).toBe('string');
      expect(String(value?.[reason]).trim(), reason).not.toBe('');
    }
  });

  it('#60 BULK_EFFECT_LABEL の値はどれも空でない文字列', () => {
    const value = labelValue('BULK_EFFECT_LABEL') as Record<string, unknown> | undefined;

    expect(value, 'BULK_EFFECT_LABEL').toBeDefined();
    for (const effect of BULK_EFFECTS) {
      expect(typeof value?.[effect], effect).toBe('string');
      expect(String(value?.[effect]).trim(), effect).not.toBe('');
    }
  });

  it.each([
    ['desired_time_passed', '希望日時を過ぎています'],
    ['stale', '内容が変わっています。読み込み直してから操作してください'],
    ['timeout', '時間内に処理できませんでした'],
  ])('#60 BULK_REASON_LABEL.%s が設計 §9.10 の「%s」', (reason, label) => {
    const value = labelValue('BULK_REASON_LABEL') as Record<string, unknown> | undefined;

    expect(String(value?.[reason] ?? '')).toContain(label);
  });

  it('#60 API_TOKEN_NAME_SOURCE_NOTE が設計 §9.9 の文', () => {
    expect(labelValue('API_TOKEN_NAME_SOURCE_NOTE')).toBe(API_TOKEN_NAME_SOURCE_NOTE_TEXT);
  });

  it('#60 判別力：キーが 1 つ欠けた・余る写しは一致しない', () => {
    const missing = Object.fromEntries(BULK_FAILURE_REASONS.slice(1).map((key) => [key, 'x']));
    const extra = Object.fromEntries([...BULK_EFFECTS, 'approved'].map((key) => [key, 'x']));

    expect(keysOf(missing)).not.toEqual([...BULK_FAILURE_REASONS].sort());
    expect(keysOf(extra)).not.toEqual([...BULK_EFFECTS].sort());
  });
});

/* -------------------------------------------------------------------------- */
/* #60 social-posts.tsx に文言を直書きしない                                      */
/* -------------------------------------------------------------------------- */

describe('#60 social-posts.tsx に §9.10 の文言を直書きしない', () => {
  it.each(POSTS_WORDS)('#60 「%s」を直書きしない', (word) => {
    expect(isHardCoded(read(POSTS_COMPONENT), word)).toBe(false);
  });

  it.each(POSTS_SHORT_WORDS)('#60 「%s」を引用符や JSX のテキストで直書きしない', (word) => {
    expect(isHardCodedShort(read(POSTS_COMPONENT), word)).toBe(false);
  });
});

describe('#60 §9.10 の文言は ui/social/labels.ts にある', () => {
  it.each(LABEL_WORDS)('#60 labels.ts に「%s」がある', (word) => {
    expect(isHardCoded(read(SOCIAL_LABELS), word)).toBe(true);
  });

  it.each(LABEL_SHORT_WORDS)('#60 labels.ts に「%s」が文字列として現れる', (word) => {
    expect(isHardCodedShort(read(SOCIAL_LABELS), word)).toBe(true);
  });

  it('#60 labels.ts に設定 → API の説明（§9.9）がある', () => {
    expect(isHardCoded(read(SOCIAL_LABELS), API_TOKEN_NAME_SOURCE_NOTE_TEXT)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #76 ページ送りと絞り込みの URL（部品側）                                        */
/* -------------------------------------------------------------------------- */

describe('#76 social-posts.tsx のページ送りは絞り込みを保つ', () => {
  it("#76 '/social?postPage=' を書かない（絞り込みを落とす URL を作らない）", () => {
    expect(isHardCoded(read(POSTS_COMPONENT), '/social?postPage=')).toBe(false);
  });

  it('#76 openPostListPage を呼んでいる', () => {
    expect(calls(read(POSTS_COMPONENT), 'openPostListPage')).toBe(true);
  });

  it('#76 post-list-params から値を import している', () => {
    const text = read(POSTS_COMPONENT);

    expect(
      importsFrom(text, '@/ui/social/post-list-params') || importsFrom(text, './post-list-params'),
    ).toBe(true);
  });

  it('#76 絞り込みの帯は postListHref で URL を作る（設計 §9.2）', () => {
    expect(calls(read(POSTS_COMPONENT), 'postListHref')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 一括の純関数のモジュール                                                       */
/* -------------------------------------------------------------------------- */

describe('ui/social/bulk-plan.ts（実装プラン T25・設計 §9.6）', () => {
  it('bulk-plan.ts がある', () => {
    expect(existsSync(BULK_PLAN)).toBe(true);
  });

  it('bulk-plan.ts は Client Component のモジュールでない（純関数の置き場）', () => {
    expect(stripComments(read(BULK_PLAN))).not.toMatch(/^\s*['"]use client['"]/m);
  });

  it('bulk-plan.ts は取り消しの対象を Domain の BULK_DELETABLE_STATUSES で決める', () => {
    const text = read(BULK_PLAN);

    expect(importsFrom(text, '@/domain/social/bulk')).toBe(true);
    expect(mentions(text, 'BULK_DELETABLE_STATUSES')).toBe(true);
  });

  it('social-posts.tsx が bulk-plan から値を import している', () => {
    const text = read(POSTS_COMPONENT);

    expect(importsFrom(text, '@/ui/social/bulk-plan') || importsFrom(text, './bulk-plan')).toBe(
      true,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 設定 → API（設計 §9.9）                                                        */
/* -------------------------------------------------------------------------- */

describe('設定 → API の「名前」の説明（設計 §9.9）', () => {
  it('api-settings.tsx が API_TOKEN_NAME_SOURCE_NOTE を使う', () => {
    expect(mentions(read(SETTINGS_COMPONENT), 'API_TOKEN_NAME_SOURCE_NOTE')).toBe(true);
  });

  it('api-settings.tsx が API_TOKEN_NAME_SOURCE_NOTE を @/ui/social/labels から import している', () => {
    const text = read(SETTINGS_COMPONENT);

    expect(importsFrom(text, '@/ui/social/labels') || importsFrom(text, '../social/labels')).toBe(
      true,
    );
  });

  it('api-settings.tsx に §9.9 の文を直書きしない', () => {
    expect(isHardCoded(read(SETTINGS_COMPONENT), '投稿一覧に『登録元』として表示されます')).toBe(
      false,
    );
  });

  it('「名前」の今の説明は残す（他は変えない）', () => {
    expect(isHardCoded(read(SETTINGS_COMPONENT), API_TOKEN_NAME_DESCRIPTION)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 述語の判別力                                                                  */
/* -------------------------------------------------------------------------- */

describe('#60 検査の述語の判別力', () => {
  it('#60 JSX のテキスト・文字列リテラル・属性に直書きした写しを見分ける', () => {
    expect(isHardCoded('<h2>一括操作の結果</h2>', '一括操作の結果')).toBe(true);
    expect(
      isHardCoded(
        "setToast({ text: '時間内に処理できませんでした' });",
        '時間内に処理できませんでした',
      ),
    ).toBe(true);
    expect(isHardCoded('<Modal title="一括送信（承認）">', '一括送信（承認）')).toBe(true);
    expect(isHardCoded('`${count} 件を選択中`', '件を選択中')).toBe(true);
  });

  it('#60 コメントの中の文言は数えない', () => {
    const text = [
      '// 「一括操作の結果」の Modal（設計 §9.7）',
      '{/* 「登録元」の列 */}',
      '/** 「条件をクリア」は条件があるときだけ */',
      '<FormField label={POST_FILTER_SOURCE_LABEL}>{POST_FILTER_ALL}</FormField>',
    ].join('\n');

    expect(isHardCoded(text, '一括操作の結果')).toBe(false);
    expect(isHardCodedShort(text, '登録元')).toBe(false);
    expect(isHardCodedShort(text, '条件をクリア')).toBe(false);
  });

  it('#60 短い語は引用符で囲んだ写し・JSX のテキストちょうどの写しを見分ける', () => {
    expect(isHardCodedShort("{ key: 'source', header: '登録元' }", '登録元')).toBe(true);
    expect(isHardCodedShort('<Button variant="primary">\n  送る\n</Button>', '送る')).toBe(true);
    expect(isHardCodedShort('<option value="">すべて</option>', 'すべて')).toBe(true);
  });

  it('#60 短い語は長い文言・別の語の部分文字列に反応しない', () => {
    expect(isHardCodedShort("const t = '一括取り消しの確認';", '一括取り消し')).toBe(false);
    expect(isHardCodedShort("const t = '送る前に確かめる';", '送る')).toBe(false);
    expect(isHardCodedShort('<p>今すぐ送る</p>', '送る')).toBe(false);
  });

  it('#76 呼び出し・import の検査はコメント・別のモジュール・型だけの import を数えない', () => {
    expect(calls('onChange={(page) => openPostListPage(filters, page)}', 'openPostListPage')).toBe(
      true,
    );
    expect(calls('// openPostListPage(filters, page)', 'openPostListPage')).toBe(false);
    expect(calls('const openPostListPage = 1;', 'openPostListPage')).toBe(false);
    expect(
      importsFrom(
        "import { openPostListPage } from '@/ui/social/post-list-params';",
        '@/ui/social/post-list-params',
      ),
    ).toBe(true);
    expect(
      importsFrom(
        "import type { PostListFilters } from '@/ui/social/post-list-params';",
        '@/ui/social/post-list-params',
      ),
    ).toBe(false);
    expect(mentions('/* API_TOKEN_NAME_SOURCE_NOTE */', 'API_TOKEN_NAME_SOURCE_NOTE')).toBe(false);
    expect(mentions('description={API_TOKEN_NAME_SOURCE_NOTE}', 'API_TOKEN_NAME_SOURCE_NOTE')).toBe(
      true,
    );
  });
});
