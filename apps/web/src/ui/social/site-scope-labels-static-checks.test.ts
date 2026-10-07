import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 053 の新しい文言を部品に直書きしない（053-site-scoped-social 設計 §9.1.6・§9.2・§9.3、
 * 受け入れ条件 #72）。
 *
 * * `/social`（`ui/social/social-accounts.tsx`）の文言は `ui/social/labels.ts`（設計 §9.1.6）
 * * 設定 → API（`ui/settings/api-settings.tsx`）の文言は `ui/settings/api-token-site.ts`
 *   （実装プラン §8 の 13。`'use client'` のモジュールに純関数を置かない）
 * * Web サイトの編集フォーム（`ui/site/site-form.tsx`）のアーカイブの説明は `ui/site/labels.ts`
 * * Web サイトの一覧（`ui/site/site-list.tsx`）は削除の 409 の文を選ぶ処理を
 *   `ui/site/site-delete-error.ts` の `siteDeleteErrorText` に任せる（§8 の 12。文はサーバの応答が持つ）
 *
 * 述語（`stripComments`・`isHardCoded`・`isHardCodedShort`）は 051 の
 * `social-account-id-static-checks.test.ts` #19（039 #46 を写したもの）を**写す**。051 は未マージで、
 * テストファイルを import しない（実装プラン §2 のテストの方法）。判別力の件も同じ形で置く。
 */

const UI_DIR = join(import.meta.dirname, '..');

const SOCIAL_COMPONENT = join(UI_DIR, 'social', 'social-accounts.tsx');
const SOCIAL_LABELS = join(UI_DIR, 'social', 'labels.ts');
const SETTINGS_COMPONENT = join(UI_DIR, 'settings', 'api-settings.tsx');
const SETTINGS_LABELS = join(UI_DIR, 'settings', 'api-token-site.ts');
const SITE_LIST = join(UI_DIR, 'site', 'site-list.tsx');
const SITE_FORM = join(UI_DIR, 'site', 'site-form.tsx');
const SITE_LABELS = join(UI_DIR, 'site', 'labels.ts');
const SITE_DELETE_ERROR = join(UI_DIR, 'site', 'site-delete-error.ts');

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

/* -------------------------------------------------------------------------- */
/* 文言（設計 §9.1・§9.2・§9.3）                                                  */
/* -------------------------------------------------------------------------- */

/** `/social` の文言（設計 §9.1.6 の定数）。部分文字列で見て誤って当たらない長さのもの。 */
const SOCIAL_WORDS = [
  '共通（どのサイトのトークンからも使える）',
  '（アーカイブ）',
  'サイトを選ぶと、そのサイトに紐づいた API トークンからだけ使えます。管理画面からはいつでも使えます。',
  'サイトの一覧を見る権限が無いため、共通で登録します。',
  'サイトの紐づけを変える',
  'このアカウントの投稿（予約・承認待ちを含む）は、変更後のサイトのトークンからだけ見えるようになります。登録済みの予約はそのまま配信されます。',
  'サイトの紐づけを変えました。',
  'サイトで絞り込む',
] as const;

/** `/social` の短い語（見出し・ボタン・選択肢の見える文字）。 */
const SOCIAL_SHORT_WORDS = ['サイト', '共通', 'サイト専用', 'すべて'] as const;

/** 設定 → API の文言（設計 §9.2・§9.2.1）。 */
const SETTINGS_WORDS = [
  '共通（サイトに紐づけない）',
  'サイトを選ぶと、このトークンはそのサイトの SNS アカウントと共通の SNS アカウントだけを使えます。付けられる権限は SNS の 4 つだけです。サイトは後から変えられます。',
  '共通のトークンは、サイトに紐づいていない SNS アカウントだけを使えます。',
  '削除されたサイト',
  'トークンのサイトを変える',
  // 後ろに外れる権限の一覧が続く（`site.read, …`）。区切りの記号の書き方には頼らない。
  'このサイトに紐づけると、次の権限が外れます',
  '権限が 1 つも残らないため、このトークンでは何もできなくなります。',
  'このトークンが共通のアカウントへ登録した投稿は、変更後の区画へ移ります。サイト専用のアカウントと、このトークンが作ったアカウントは元のサイトに残り、変更後は見えなくなることがあります。',
  'トークンのサイトを変えました。',
] as const;

/** 設定 → API の短い語のうち、`api-token-site.ts` に置くもの（ボタンの見える文字）。 */
const SETTINGS_OWN_SHORT_WORDS = ['サイトを変える', '変える'] as const;

/** 設定 → API の短い語のうち、`/social` と同じ言い方のもの（どちらの定数のモジュールにあってもよい）。 */
const SETTINGS_SHARED_SHORT_WORDS = ['サイト', '共通', 'サイト専用'] as const;

/** Web サイトの編集フォームの「状態」の説明（設計 §9.3。裁定 8）。 */
const SITE_FORM_WORDS = [
  'アーカイブすると、このサイトに紐づいた API トークンは使えなくなります（戻すと再び使えます）。',
] as const;

/** 削除の 409 の文（設計 §8.6）。サーバの応答が持つので、部品にも定数にも書かない。 */
const SITE_IN_USE_FRAGMENT = 'このサイトに紐づいた SNS アカウントが';

/* -------------------------------------------------------------------------- */
/* 前提：部品のファイルがある                                                     */
/* -------------------------------------------------------------------------- */

describe('#72 前提：検査する部品がある（空振りしない）', () => {
  it.each([
    ['ui/social/social-accounts.tsx', SOCIAL_COMPONENT],
    ['ui/settings/api-settings.tsx', SETTINGS_COMPONENT],
    ['ui/site/site-list.tsx', SITE_LIST],
    ['ui/site/site-form.tsx', SITE_FORM],
  ])('#72 %s がある', (_name, path) => {
    expect(existsSync(path)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* /social                                                                     */
/* -------------------------------------------------------------------------- */

describe('#72 social-accounts.tsx に §9.1 の文言を直書きしない', () => {
  it.each(SOCIAL_WORDS)('#72 「%s」を直書きしない', (word) => {
    expect(isHardCoded(read(SOCIAL_COMPONENT), word)).toBe(false);
  });

  it.each(SOCIAL_SHORT_WORDS)('#72 「%s」を引用符や JSX のテキストで直書きしない', (word) => {
    expect(isHardCodedShort(read(SOCIAL_COMPONENT), word)).toBe(false);
  });
});

describe('#72 §9.1 の文言は ui/social/labels.ts にある', () => {
  it.each(SOCIAL_WORDS)('#72 labels.ts に「%s」がある', (word) => {
    expect(isHardCoded(read(SOCIAL_LABELS), word)).toBe(true);
  });

  it.each(SOCIAL_SHORT_WORDS)('#72 labels.ts に「%s」が文字列として現れる', (word) => {
    expect(isHardCodedShort(read(SOCIAL_LABELS), word)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 設定 → API                                                                   */
/* -------------------------------------------------------------------------- */

describe('#72 api-settings.tsx に §9.2 の文言を直書きしない', () => {
  it.each(SETTINGS_WORDS)('#72 「%s」を直書きしない', (word) => {
    expect(isHardCoded(read(SETTINGS_COMPONENT), word)).toBe(false);
  });

  it.each([...SETTINGS_OWN_SHORT_WORDS, ...SETTINGS_SHARED_SHORT_WORDS])(
    '#72 「%s」を引用符や JSX のテキストで直書きしない',
    (word) => {
      expect(isHardCodedShort(read(SETTINGS_COMPONENT), word)).toBe(false);
    },
  );
});

describe('#72 §9.2 の文言は ui/settings/api-token-site.ts にある', () => {
  it('#72 ui/settings/api-token-site.ts がある', () => {
    expect(existsSync(SETTINGS_LABELS)).toBe(true);
  });

  it('#72 api-token-site.ts は Client Component のモジュールでない（純関数と定数の置き場）', () => {
    expect(stripComments(read(SETTINGS_LABELS))).not.toMatch(/^\s*['"]use client['"]/m);
  });

  it.each(SETTINGS_WORDS)('#72 api-token-site.ts に「%s」がある', (word) => {
    expect(isHardCoded(read(SETTINGS_LABELS), word)).toBe(true);
  });

  it.each(SETTINGS_OWN_SHORT_WORDS)(
    '#72 api-token-site.ts に「%s」が文字列として現れる',
    (word) => {
      expect(isHardCodedShort(read(SETTINGS_LABELS), word)).toBe(true);
    },
  );

  it.each(SETTINGS_SHARED_SHORT_WORDS)(
    '#72 「%s」が api-token-site.ts か ui/social/labels.ts に文字列として現れる',
    (word) => {
      expect(
        isHardCodedShort(read(SETTINGS_LABELS), word) ||
          isHardCodedShort(read(SOCIAL_LABELS), word),
      ).toBe(true);
    },
  );
});

/**
 * `SITE_TOKEN_SCOPES` は Server Component から props で渡す（設計 §9.2「部品に一覧を持たない」）。
 * 部品が Domain の定数を読んだり、SNS の権限の一覧を自前で書いたりしていないこと。
 */
describe('#72 api-settings.tsx はサイトのトークンの権限の一覧を持たない', () => {
  it('#72 api-settings.tsx が SITE_TOKEN_SCOPES を参照しない', () => {
    expect(stripComments(read(SETTINGS_COMPONENT))).not.toMatch(/\bSITE_TOKEN_SCOPES\b/);
  });

  it.each(['social.read', 'social.write', 'social.delete', 'social.approve'])(
    '#72 api-settings.tsx に %s を文字列で書かない',
    (scope) => {
      expect(isHardCodedShort(read(SETTINGS_COMPONENT), scope)).toBe(false);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Web サイト                                                                   */
/* -------------------------------------------------------------------------- */

/** `import { …, name, … } from 'specifier'`（`import type` は数えない）。 */
function importsName(text: string, name: string, specifier: string): boolean {
  const pattern = new RegExp(
    `import\\s*\\{[^}]*(?<![\\w$])${escapeRegExp(name)}(?![\\w$])[^}]*\\}\\s*from\\s*(['"])${escapeRegExp(specifier)}\\1`,
  );
  return pattern.test(stripComments(text));
}

/** `import … from 'specifier'`（値の import。`import type` は数えない）。 */
function importsFrom(text: string, specifier: string): boolean {
  const pattern = new RegExp(
    `import\\s+(?!type\\s)[^;]*?from\\s*(['"])${escapeRegExp(specifier)}\\1`,
  );
  return pattern.test(stripComments(text));
}

describe('#72 site-form.tsx のアーカイブの説明は ui/site/labels.ts', () => {
  it.each(SITE_FORM_WORDS)('#72 site-form.tsx に「%s」を直書きしない', (word) => {
    expect(isHardCoded(read(SITE_FORM), word)).toBe(false);
  });

  it.each(SITE_FORM_WORDS)('#72 ui/site/labels.ts に「%s」がある', (word) => {
    expect(isHardCoded(read(SITE_LABELS), word)).toBe(true);
  });

  it('#72 site-form.tsx が @/ui/site/labels から値を import している', () => {
    expect(importsFrom(read(SITE_FORM), '@/ui/site/labels')).toBe(true);
  });
});

describe('#72 site-list.tsx は削除の失敗の文を siteDeleteErrorText で選ぶ', () => {
  it('#72 ui/site/site-delete-error.ts がある', () => {
    expect(existsSync(SITE_DELETE_ERROR)).toBe(true);
  });

  it('#72 site-list.tsx が @/ui/site/site-delete-error から siteDeleteErrorText を import している', () => {
    expect(importsName(read(SITE_LIST), 'siteDeleteErrorText', '@/ui/site/site-delete-error')).toBe(
      true,
    );
  });

  it('#72 site-list.tsx が siteDeleteErrorText を呼んでいる', () => {
    expect(stripComments(read(SITE_LIST))).toMatch(/(?<![\w$])siteDeleteErrorText\s*\(/);
  });

  it('#72 site-list.tsx に削除の 409 の文を直書きしない', () => {
    expect(isHardCoded(read(SITE_LIST), SITE_IN_USE_FRAGMENT)).toBe(false);
  });

  it('#72 site-list.tsx は details.socialAccounts を自分で読まない（選ぶ処理は純関数）', () => {
    expect(stripComments(read(SITE_LIST))).not.toMatch(/\bsocialAccounts\b/);
  });

  it('#72 削除の 409 の文は UI の定数にも書かない（サーバの応答が持つ）', () => {
    for (const path of [SOCIAL_LABELS, SETTINGS_LABELS, SITE_LABELS, SITE_DELETE_ERROR]) {
      expect(isHardCoded(read(path), SITE_IN_USE_FRAGMENT), path).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 述語の判別力                                                                  */
/* -------------------------------------------------------------------------- */

describe('#72 検査の述語の判別力', () => {
  it('#72 JSX のテキストに直書きした写しを見分ける', () => {
    expect(isHardCoded('<p>サイトで絞り込む</p>', 'サイトで絞り込む')).toBe(true);
  });

  it('#72 文字列リテラル・属性に直書きした写しを見分ける', () => {
    expect(
      isHardCoded(
        "setToast({ text: 'サイトの紐づけを変えました。' });",
        'サイトの紐づけを変えました。',
      ),
    ).toBe(true);
    expect(isHardCoded('<Modal title="サイトの紐づけを変える">', 'サイトの紐づけを変える')).toBe(
      true,
    );
  });

  it('#72 テンプレートリテラルに埋めた写しを見分ける', () => {
    expect(
      isHardCoded(
        'text={`このサイトに紐づけると、次の権限が外れます：${removed.join(", ")}`}',
        'このサイトに紐づけると、次の権限が外れます',
      ),
    ).toBe(true);
  });

  it('#72 コメントの中の文言は数えない', () => {
    const text = [
      '// 「サイト」の列（053 設計 §9.1.1）',
      '{/* 「サイトで絞り込む」は手元で絞る */}',
      '/** 共通（どのサイトのトークンからも使える） */',
      '<FormField label={SITE_COLUMN_HEADER}>{SITE_FILTER_ALL}</FormField>',
    ].join('\n');

    expect(isHardCoded(text, 'サイトで絞り込む')).toBe(false);
    expect(isHardCoded(text, '共通（どのサイトのトークンからも使える）')).toBe(false);
    expect(isHardCodedShort(text, 'サイト')).toBe(false);
  });

  it('#72 短い語は引用符で囲んだ写し・JSX のテキストちょうどの写しを見分ける', () => {
    expect(isHardCodedShort('<FormField label="サイト">', 'サイト')).toBe(true);
    expect(isHardCodedShort("{ key: 'site', header: 'サイト' }", 'サイト')).toBe(true);
    expect(isHardCodedShort('<Button variant="ghost">\n  サイト\n</Button>', 'サイト')).toBe(true);
    expect(isHardCodedShort('<option value="">すべて</option>', 'すべて')).toBe(true);
  });

  it('#72 短い語は長い文言・別の語の部分文字列に反応しない', () => {
    expect(isHardCodedShort("const t = 'サイトの紐づけを変える';", 'サイト')).toBe(false);
    expect(isHardCodedShort('<h1>Webサイト</h1>', 'サイト')).toBe(false);
    expect(isHardCodedShort("const t = 'トークンのサイトを変える';", 'サイトを変える')).toBe(false);
    expect(isHardCodedShort("const t = 'サイトを変える';", '変える')).toBe(false);
  });

  it('#72 import の検査は別のモジュール・型だけの import・コメントの中を数えない', () => {
    const name = 'siteDeleteErrorText';
    const specifier = '@/ui/site/site-delete-error';

    expect(importsName(`import {\n  ${name},\n} from '${specifier}';`, name, specifier)).toBe(true);
    expect(importsName(`import { ${name} } from '@/ui/site/labels';`, name, specifier)).toBe(false);
    expect(importsName(`import type { ${name} } from '${specifier}';`, name, specifier)).toBe(
      false,
    );
    expect(importsName(`// import { ${name} } from '${specifier}';`, name, specifier)).toBe(false);
    expect(
      importsFrom("import { SITE_ARCHIVE_NOTE } from '@/ui/site/labels';", '@/ui/site/labels'),
    ).toBe(true);
    expect(importsFrom("import type { X } from '@/ui/site/labels';", '@/ui/site/labels')).toBe(
      false,
    );
  });
});
