import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SocialAccounts, type SocialAccountsProps } from './social-accounts';

// 部品は保存・消去の後に `router.refresh()` を呼ぶ（039 設計 §7.3.4）。
// `useRouter` は App Router の外では例外を投げるので差し替える（`social-accounts.test.ts` と同じ）。
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

/**
 * SNS アカウントの一覧に ID の全桁と「コピー」を出す（051-social-account-id-display 設計 §7.1〜§7.3、
 * 受け入れ条件 #1〜#10）。
 *
 * * 「行の HTML」：`renderToStaticMarkup` の出力を `<tr` で区切り、`</tr>` までを切り出した部分。
 *   見出しの行（`<th` を含む）は除く。どの行かは行の中の表示名で選ぶ（並びに頼らない）
 * * 「ID の要素」：`data-account-id` を持つ `<code>`
 * * 既定の props は `social-accounts.test.ts` と同じ形（provider `bluesky`（`Bluesky`）・`x`、
 *   `permissions` は `social.read` / `social.write` / `social.delete`）を写す（import しない）
 * * アカウントは 2 つ。ID は UUIDv7 の形で、**先頭 8 桁が同じで末尾だけ違う**（設計 §1.2 の 3）。
 *   英字 `a`〜`f` を含めて、大文字・小文字の取り違えを見分けられるようにする
 */

const PROVIDERS: SocialAccountsProps['providers'] = [
  {
    value: 'bluesky',
    label: 'Bluesky',
    credentialFields: [
      { key: 'identifier', label: '識別子', kind: 'text' },
      { key: 'appPassword', label: 'アプリパスワード', kind: 'secret' },
    ],
  },
  { value: 'x', label: 'X', credentialFields: [] },
];

const ID_A = '0192b7a0-5c1e-7a3b-9f10-2d7c4e8a1b23';
const ID_B = '0192b7a0-5c1e-7a3b-9f10-2d7c4e8a1b9f';

const ACCOUNT_A = {
  id: ID_A,
  provider: 'bluesky',
  displayName: 'とりふね公式',
  handle: '@torifune',
  status: 'connected',
  credentialConfigured: true,
};

const ACCOUNT_B = {
  id: ID_B,
  provider: 'x',
  displayName: 'とりふね開発',
  handle: '@torifune_dev',
  status: 'connected',
  credentialConfigured: true,
};

const BASE: SocialAccountsProps = {
  initialAccounts: [ACCOUNT_A, ACCOUNT_B],
  permissions: ['social.read', 'social.write', 'social.delete'],
  providers: PROVIDERS,
};

/** 既定の 2 行と、それぞれの行の表示名・サービスの表示名・もう一方の行の ID。 */
const ROWS = [
  { account: ACCOUNT_A, providerLabel: 'Bluesky', otherId: ID_B },
  { account: ACCOUNT_B, providerLabel: 'X', otherId: ID_A },
] as const;

function render(overrides: Partial<SocialAccountsProps> = {}): string {
  return renderToStaticMarkup(createElement(SocialAccounts, { ...BASE, ...overrides }));
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 属性値の実体参照を戻す（`renderToStaticMarkup` は `"` `'` `&` `<` `>` を参照にする）。 */
function decodeAttribute(value: string): string {
  return textOf(value);
}

/** 本体の行（見出しの行を除く）の HTML。 */
function bodyRows(html: string): string[] {
  return html
    .split('<tr')
    .slice(1)
    .map((piece) => {
      const end = piece.indexOf('</tr>');
      return `<tr${end === -1 ? piece : piece.slice(0, end + '</tr>'.length)}`;
    })
    .filter((row) => !row.includes('<th'));
}

/** 表示名で選んだ行の HTML。ちょうど 1 行あることも確かめる。 */
function rowOf(html: string, displayName: string): string {
  const rows = bodyRows(html).filter((row) => textOf(row).includes(displayName));
  expect(rows, `表示名「${displayName}」の行`).toHaveLength(1);
  return rows[0] as string;
}

/** 見出し（`<th>` のテキスト）の並び。 */
function headers(html: string): string[] {
  return [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((match) =>
    textOf(match[1] as string).trim(),
  );
}

interface IdElement {
  /** `<code …>` の開始タグ。 */
  readonly openTag: string;
  /** `data-account-id` の値（実体参照を戻したもの）。 */
  readonly attribute: string;
  /** `<code>` の中身の HTML。 */
  readonly inner: string;
}

/** 行の中の ID の要素（`data-account-id` を持つ `<code>`）。 */
function idElements(html: string): IdElement[] {
  return [
    ...html.matchAll(/(<code\b[^>]*\bdata-account-id="([^"]*)"[^>]*>)([\s\S]*?)<\/code>/g),
  ].map((match) => ({
    openTag: match[1] as string,
    attribute: decodeAttribute(match[2] as string),
    inner: match[3] as string,
  }));
}

/** `style` 属性の宣言（`property:value`）。空白を除いて並べる。 */
function styleDeclarations(openTag: string): string[] {
  const style = /\bstyle="([^"]*)"/.exec(openTag)?.[1] ?? '';
  return decodeAttribute(style)
    .split(';')
    .map((declaration) => declaration.replace(/\s+/g, ''))
    .filter((declaration) => declaration !== '');
}

/** 見える文字がちょうど「コピー」のボタン（開始タグ）。 */
function copyButtons(html: string): string[] {
  return [...html.matchAll(/(<button\b[^>]*>)\s*コピー\s*<\/button>/g)].map(
    (match) => match[1] as string,
  );
}

/** 見える文字がちょうど `label` のボタンの数（`social-accounts-credentials.test.ts` と同じ数え方）。 */
function buttonCount(html: string, label: string): number {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].filter(
    (match) => textOf(match[1] as string).trim() === label,
  ).length;
}

function attributeOf(openTag: string, name: string): string | undefined {
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(openTag)?.[1];
  return value === undefined ? undefined : decodeAttribute(value);
}

function copyAriaLabel(displayName: string, providerLabel: string): string {
  return `「${displayName}（${providerLabel}）」のアカウントIDをコピー`;
}

/* -------------------------------------------------------------------------- */
/* 列の並び（#1・#9）                                                           */
/* -------------------------------------------------------------------------- */

describe('列の並び', () => {
  // 053 で「サイト」が「アカウントID」と「資格情報」の間に入った（053-site-scoped-social 設計 §16）。
  it('#1 見出しが「サービス」「表示名」「ハンドル」「アカウントID」「サイト」「資格情報」「状態」「操作」の順に並ぶ', () => {
    expect(headers(render())).toEqual([
      'サービス',
      '表示名',
      'ハンドル',
      'アカウントID',
      'サイト',
      '資格情報',
      '状態',
      '操作',
    ]);
  });

  it.each(ROWS)(
    '#9 $account.displayName の行で「コピー」が「••••••••」「資格情報を設定」「削除」より前にある',
    ({ account }) => {
      const row = rowOf(render(), account.displayName);
      const copy = row.search(/<button\b[^>]*>\s*コピー\s*<\/button>/);

      expect(copy, '「コピー」のボタンが行に無い').toBeGreaterThanOrEqual(0);
      // ボタンが「操作」列ではなく、資格情報の列より左のアカウントID の列にある。
      expect(copy).toBeLessThan(row.indexOf('••••••••'));
      expect(copy).toBeLessThan(row.indexOf('資格情報を設定'));
      expect(copy).toBeLessThan(row.search(/>\s*削除\s*<\/button>/));
    },
  );
});

/* -------------------------------------------------------------------------- */
/* ID の全桁（#2〜#5）                                                          */
/* -------------------------------------------------------------------------- */

describe('ID の全桁', () => {
  it.each(ROWS)(
    '#2 $account.displayName の行のテキストにその行の ID の全桁があり、もう一方の行の ID は無い',
    ({ account, otherId }) => {
      const text = textOf(rowOf(render(), account.displayName));

      expect(account.id).toHaveLength(36);
      expect(text).toContain(account.id);
      expect(text).not.toContain(otherId);
    },
  );

  it.each(ROWS)(
    '#3 $account.displayName の行に ID の要素がちょうど 1 つあり、data-account-id とテキストがその行の ID と完全に一致する',
    ({ account }) => {
      const elements = idElements(rowOf(render(), account.displayName));

      expect(elements).toHaveLength(1);
      // 大文字・小文字も同じ（toBe は文字列を厳密に比べる）。
      expect(elements[0]?.attribute).toBe(account.id);
      expect(textOf(elements[0]?.inner ?? '')).toBe(account.id);
    },
  );

  it.each(ROWS)(
    '#4 $account.displayName の行の ID の要素に <wbr/> がちょうど 4 つあり、それぞれ - の直後にある',
    ({ account }) => {
      const inner = idElements(rowOf(render(), account.displayName))[0]?.inner ?? '';
      const breaks = [...inner.matchAll(/<wbr\s*\/?>/g)];

      expect(breaks).toHaveLength(4);
      for (const found of breaks) {
        const before = textOf(inner.slice(0, found.index));
        expect(before.endsWith('-'), `<wbr/> の直前が「${before.slice(-1)}」`).toBe(true);
      }
    },
  );

  it.each(ROWS)(
    '#5 $account.displayName の行の ID の要素の style に user-select:all と font-family:var(--tf-font-mono) がある',
    ({ account }) => {
      const openTag = idElements(rowOf(render(), account.displayName))[0]?.openTag ?? '';
      const declarations = styleDeclarations(openTag);

      expect(declarations).toContain('user-select:all');
      expect(declarations).toContain('font-family:var(--tf-font-mono)');
    },
  );
});

/* -------------------------------------------------------------------------- */
/* コピーのボタン（#6・#7）                                                     */
/* -------------------------------------------------------------------------- */

describe('コピーのボタン', () => {
  it.each(ROWS)(
    '#6 $account.displayName の行に見える文字が「コピー」のボタンがちょうど 1 つあり、type="button" と「<表示名>（<サービス>）」の aria-label を持つ',
    ({ account, providerLabel }) => {
      const buttons = copyButtons(rowOf(render(), account.displayName));

      expect(buttons).toHaveLength(1);
      const button = buttons[0] as string;
      expect(attributeOf(button, 'type')).toBe('button');
      expect(attributeOf(button, 'aria-label')).toBe(
        copyAriaLabel(account.displayName, providerLabel),
      );
    },
  );

  it('#6 aria-label の例：「とりふね公式（Bluesky）」のアカウントIDをコピー', () => {
    const button = copyButtons(rowOf(render(), 'とりふね公式'))[0] ?? '';

    expect(attributeOf(button, 'aria-label')).toBe(
      '「とりふね公式（Bluesky）」のアカウントIDをコピー',
    );
  });

  /** provider が providers に無い行と、provider が原型のプロパティ名の行（047 設計 §4.1）。 */
  const UNLISTED = {
    id: '0192b7a0-5c1e-7a3b-9f10-2d7c4e8a1c01',
    provider: 'mastodon',
    displayName: 'とりふねマストドン',
    handle: '@torifune@social.example',
    status: 'connected',
    credentialConfigured: true,
  };
  const PROTOTYPE_KEY = {
    id: '0192b7a0-5c1e-7a3b-9f10-2d7c4e8a1c02',
    provider: 'constructor',
    displayName: 'とりふね原型',
    handle: '@torifune_proto',
    status: 'connected',
    credentialConfigured: true,
  };

  it('#7 provider が providers に無い行（mastodon）は aria-label のサービスの部分が provider の値そのもの', () => {
    const html = render({ initialAccounts: [UNLISTED, PROTOTYPE_KEY] });
    const button = copyButtons(rowOf(html, UNLISTED.displayName))[0] ?? '';

    expect(attributeOf(button, 'aria-label')).toBe(copyAriaLabel(UNLISTED.displayName, 'mastodon'));
  });

  it('#7 provider が constructor の行は aria-label のサービスの部分が provider の値そのもの', () => {
    const html = render({ initialAccounts: [UNLISTED, PROTOTYPE_KEY] });
    const button = copyButtons(rowOf(html, PROTOTYPE_KEY.displayName))[0] ?? '';

    expect(attributeOf(button, 'aria-label')).toBe(
      copyAriaLabel(PROTOTYPE_KEY.displayName, 'constructor'),
    );
  });

  it('#7 provider が constructor の行で function Object が HTML に現れない', () => {
    const html = render({ initialAccounts: [UNLISTED, PROTOTYPE_KEY] });

    // 前提：その行に「コピー」が描かれている（空振りしない）。
    expect(copyButtons(rowOf(html, PROTOTYPE_KEY.displayName))).toHaveLength(1);
    expect(html).not.toContain('function Object');
  });
});

/* -------------------------------------------------------------------------- */
/* social.read だけの利用者（#8）                                               */
/* -------------------------------------------------------------------------- */

describe('social.read だけの利用者', () => {
  const readOnly = (): string => render({ permissions: ['social.read'] });

  it.each(ROWS)('#8 $account.displayName の行に ID の要素と「コピー」がある', ({ account }) => {
    const row = rowOf(readOnly(), account.displayName);

    expect(idElements(row)).toHaveLength(1);
    expect(idElements(row)[0]?.attribute).toBe(account.id);
    expect(copyButtons(row)).toHaveLength(1);
  });

  it('#8 このとき「資格情報を設定」「削除」は無い（既存 #16 と両立する）', () => {
    const html = readOnly();

    expect(buttonCount(html, '資格情報を設定')).toBe(0);
    expect(buttonCount(html, '削除')).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 空の一覧（#10）                                                              */
/* -------------------------------------------------------------------------- */

describe('空の一覧', () => {
  const empty = (): string => render({ initialAccounts: [] });

  it('#10 アカウントが空なら「アカウントID」の見出しが無い', () => {
    const html = empty();

    expect(headers(html)).not.toContain('アカウントID');
    expect(textOf(html)).not.toContain('アカウントID');
  });

  it('#10 アカウントが空なら「コピー」のボタンが無い', () => {
    expect(copyButtons(empty())).toHaveLength(0);
  });

  it('#10 アカウントが空なら ID の要素が無い', () => {
    const html = empty();

    expect(idElements(html)).toHaveLength(0);
    expect(html).not.toContain('data-account-id');
  });

  it('#10 アカウントが空なら今までどおり空の表示になる', () => {
    expect(textOf(empty())).toContain('SNSアカウントが登録されていません。');
  });
});
