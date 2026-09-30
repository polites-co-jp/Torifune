import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PluginManager, type PluginManagerProps, type PluginRow } from '@/ui/plugin/plugin-manager';
import { PermissionMatrix, type PermissionMatrixProps } from '@/ui/settings/permission-matrix';
import { NO_PUBLISHER_BADGE } from '@/ui/social/labels';
import { buildProviderOptions } from '@/ui/social/provider-options';
import {
  SocialAccounts,
  type AccountRow,
  type SocialAccountsProps,
} from '@/ui/social/social-accounts';
import { SocialPosts, type PostRow, type SocialPostsProps } from '@/ui/social/social-posts';

/**
 * 原型の名前（`constructor` など）をキーにした辞書を読む画面の部品
 * （047-prototype-key-sweep 設計 §4.2・§6、受け入れ条件 #3 の後半・#4・#5・#6）。
 *
 * 変更前に起きていたこと（設計 §1.2）：
 *
 * * `PluginManager`：`toString` などの Permission の説明が関数になり、` — ` の後が空欄。
 *   React が `Functions are not valid as a React child` を記録する（K6）
 * * `PermissionMatrix`：grants に `constructor` の自分のキーが無いと
 *   `props.grants[role.name]?.includes` が `Object` 関数を通して TypeError（K2）
 * * `SocialAccounts`：provider が `constructor` の行の「サービス」列が空欄、Modal の対象が
 *   `（function Object() { [native code] }）`（K4）
 * * `SocialPosts`：`Object` 関数に `publish` が無いので偶然 `no_publisher`（K5。回帰の守り）
 *
 * `console.error` は各件の中で `vi.spyOn` で拾い、終わりに戻す（実装プラン §7 の 3）。
 */

// `SocialAccounts` は `useRouter` を使う。App Router の外では例外を投げるので差し替える
// （`ui/social/social-accounts-credentials.test.ts` と同じ形）。
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const FUNCTION_CHILD_WARNING = 'Functions are not valid as a React child';

/* -------------------------------------------------------------------------- */
/* 描画と HTML の読み方                                                           */
/* -------------------------------------------------------------------------- */

/** 描いて、描画中に `console.error` へ出た文言を集める。 */
function renderCapturingErrors(render: () => string): { html: string; errors: string } {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const html = render();
    const errors = spy.mock.calls.map((call) => call.map((part) => String(part)).join(' '));
    return { html, errors: errors.join('\n') };
  } finally {
    spy.mockRestore();
  }
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

/** `<tr>` の中身（見出し行を含む）。 */
function rowsOf(html: string): string[] {
  return [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => match[1] ?? '');
}

/** 行の最初の `<td>` の文字。 */
function firstCellText(rowHtml: string): string {
  const match = /<td\b[^>]*>([\s\S]*?)<\/td>/.exec(rowHtml);
  return textOf(match?.[1] ?? '');
}

/* -------------------------------------------------------------------------- */
/* #3 PluginManager の権限の一覧                                                  */
/* -------------------------------------------------------------------------- */

const PLUGIN_ROW: PluginRow = {
  id: 'sample-plugin',
  name: 'サンプルPlugin',
  version: '1.0.0',
  status: 'enabled',
  loaded: true,
  permissions: ['toString', 'constructor', 'site.read'],
  dependencies: {},
  description: null,
  author: null,
  extensions: [],
  publishers: [],
};

const PLUGIN_MANAGER_BASE: PluginManagerProps = {
  installed: [PLUGIN_ROW],
  detected: [],
  problems: [],
  operations: [],
  canSelfRestart: true,
  tab: 'installed',
};

/** 権限の一覧の `<li>`（`<code>名前</code>` で始まるもの）。 */
function permissionItem(html: string, permission: string): string | undefined {
  return [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)]
    .map((match) => match[1] ?? '')
    .find((item) => item.startsWith(`<code>${permission}</code>`));
}

describe('#3 PluginManager は原型の名前の Permission に説明を出さない', () => {
  function renderPluginManager(): { html: string; errors: string } {
    return renderCapturingErrors(() =>
      renderToStaticMarkup(createElement(PluginManager, PLUGIN_MANAGER_BASE)),
    );
  }

  it.each(['toString', 'constructor'])('#3 %s の <li> に説明の区切り — が無い', (permission) => {
    const { html } = renderPluginManager();
    const item = permissionItem(html, permission);

    expect(item).toBeDefined();
    expect(textOf(item ?? '')).not.toContain(' — ');
  });

  it('#3 site.read の <li> には説明の区切り — がある（従来どおり）', () => {
    const { html } = renderPluginManager();
    const item = permissionItem(html, 'site.read');

    expect(item).toBeDefined();
    expect(textOf(item ?? '')).toContain(' — ');
  });

  it('#3 描画中に Functions are not valid as a React child が出ない', () => {
    const { errors } = renderPluginManager();

    expect(errors).not.toContain(FUNCTION_CHILD_WARNING);
  });
});

/* -------------------------------------------------------------------------- */
/* #4 PermissionMatrix                                                        */
/* -------------------------------------------------------------------------- */

const MATRIX_ROLES: PermissionMatrixProps['roles'] = [
  { id: '01900000-0000-7000-8000-000000047001', name: 'administrator', displayName: '管理者' },
  { id: '01900000-0000-7000-8000-000000047002', name: 'constructor', displayName: '構築者' },
  { id: '01900000-0000-7000-8000-000000047003', name: 'editor', displayName: '編集者' },
  { id: '01900000-0000-7000-8000-000000047004', name: 'viewer', displayName: '閲覧者' },
];

const MATRIX_PERMISSIONS: PermissionMatrixProps['permissions'] = [
  { name: 'site.read', displayName: 'サイトの閲覧' },
  { name: 'site.write', displayName: 'サイトの編集' },
  { name: 'user.manage', displayName: 'ユーザー管理' },
];

/** 標準の 3 ロールだけの grants（`constructor` の自分のキーが無い）。 */
const STANDARD_GRANTS: PermissionMatrixProps['grants'] = {
  administrator: ['site.read', 'site.write', 'user.manage'],
  editor: ['site.read', 'site.write'],
  viewer: ['site.read'],
};

const CONSTRUCTOR_COLUMN = MATRIX_ROLES.findIndex((role) => role.name === 'constructor');

function renderMatrix(grants: PermissionMatrixProps['grants']): string {
  return renderToStaticMarkup(
    createElement(PermissionMatrix, {
      roles: MATRIX_ROLES,
      permissions: MATRIX_PERMISSIONS,
      grants,
    }),
  );
}

/** Permission 名 → 列ごとの `aria-label`（`あり`／`なし`）。 */
function matrixCells(html: string): Map<string, string[]> {
  const cells = new Map<string, string[]>();
  for (const row of rowsOf(html)) {
    const name = /<code\b[^>]*>([^<]*)<\/code>/.exec(row)?.[1];
    if (name === undefined) continue;
    cells.set(
      name,
      [...row.matchAll(/aria-label="(あり|なし)"/g)].map((match) => match[1] ?? ''),
    );
  }
  return cells;
}

describe('#4 PermissionMatrix は grants に無い constructor のロールを描ける', () => {
  it('#4 grants に constructor のキーが無くても例外を投げない', () => {
    expect(() => renderMatrix(STANDARD_GRANTS)).not.toThrow();
  });

  it('#4 grants に constructor のキーが無ければ、その列はすべて「なし」', () => {
    const cells = matrixCells(renderMatrix(STANDARD_GRANTS));

    expect(cells.size).toBe(MATRIX_PERMISSIONS.length);
    for (const permission of MATRIX_PERMISSIONS) {
      expect(cells.get(permission.name)?.[CONSTRUCTOR_COLUMN]).toBe('なし');
    }
  });

  it('#4 grants の constructor（自分のキー）に site.read があれば、その行の列だけ「あり」', () => {
    const grants: PermissionMatrixProps['grants'] = Object.fromEntries([
      ['administrator', ['site.read', 'site.write', 'user.manage']],
      ['constructor', ['site.read']],
    ]);

    const cells = matrixCells(renderMatrix(grants));

    expect(cells.size).toBe(MATRIX_PERMISSIONS.length);
    expect(cells.get('site.read')?.[CONSTRUCTOR_COLUMN]).toBe('あり');
    expect(cells.get('site.write')?.[CONSTRUCTOR_COLUMN]).toBe('なし');
    expect(cells.get('user.manage')?.[CONSTRUCTOR_COLUMN]).toBe('なし');
  });
});

/* -------------------------------------------------------------------------- */
/* #5 SocialAccounts                                                          */
/* -------------------------------------------------------------------------- */

const CONSTRUCTOR_ACCOUNT: AccountRow = {
  id: '01900000-0000-7000-8000-000000047a01',
  provider: 'constructor',
  displayName: 'とりふね',
  handle: '@torifune',
  status: 'connected',
  credentialConfigured: false,
};

const X_ACCOUNT: AccountRow = {
  id: '01900000-0000-7000-8000-000000047a02',
  provider: 'x',
  displayName: 'X 公式',
  handle: '@x_official',
  status: 'connected',
  credentialConfigured: false,
};

const ACCOUNTS_BASE: SocialAccountsProps = {
  initialAccounts: [CONSTRUCTOR_ACCOUNT, X_ACCOUNT],
  permissions: ['social.read', 'social.write', 'social.delete'],
  providers: buildProviderOptions([]),
};

function renderAccounts(overrides: Partial<SocialAccountsProps> = {}): {
  html: string;
  errors: string;
} {
  return renderCapturingErrors(() =>
    renderToStaticMarkup(createElement(SocialAccounts, { ...ACCOUNTS_BASE, ...overrides })),
  );
}

/** 表示名を含む本文の行の「サービス」列（最初の `<td>`）。 */
function serviceCellOf(html: string, displayName: string): string | undefined {
  const row = rowsOf(html).find((candidate) => textOf(candidate).includes(displayName));
  return row === undefined ? undefined : firstCellText(row);
}

describe('#5 SocialAccounts は provider が constructor の行を生の値で出す', () => {
  it('#5 「サービス」列が constructor', () => {
    const { html } = renderAccounts();

    expect(serviceCellOf(html, CONSTRUCTOR_ACCOUNT.displayName)).toBe('constructor');
  });

  it('#5 HTML に function Object が無い', () => {
    const { html } = renderAccounts();

    expect(html).not.toContain('function Object');
  });

  it('#5 描画中に Functions are not valid as a React child が出ない', () => {
    const { errors } = renderAccounts();

    expect(errors).not.toContain(FUNCTION_CHILD_WARNING);
  });

  it('#5 資格情報の Modal の対象が「対象：とりふね（constructor）」', () => {
    const { html } = renderAccounts({
      initialAccounts: [CONSTRUCTOR_ACCOUNT],
      initialEditingAccountId: CONSTRUCTOR_ACCOUNT.id,
    });

    expect(textOf(html)).toContain('対象：とりふね（constructor）');
    expect(html).not.toContain('function Object');
  });

  it('#5 従来どおり：provider が x の行の「サービス」列は X', () => {
    const { html } = renderAccounts();

    expect(serviceCellOf(html, X_ACCOUNT.displayName)).toBe('X');
  });
});

/* -------------------------------------------------------------------------- */
/* #6 SocialPosts                                                             */
/* -------------------------------------------------------------------------- */

const POST_ACCOUNT_ID = '01900000-0000-7000-8000-000000047b01';

const SCHEDULED_AUTO_POST: PostRow = {
  id: '01900000-0000-7000-8000-000000047b02',
  socialAccountId: POST_ACCOUNT_ID,
  body: '原型の名前の provider への予約',
  scheduledAt: '2026-09-26T10:00:00.000Z',
  status: 'scheduled',
  publishedAt: null,
  deliveryMode: 'auto',
  failureReason: null,
  attemptCount: 0,
  externalUrl: null,
  skipCount: 0,
};

const POSTS_BASE: SocialPostsProps = {
  initialPosts: [SCHEDULED_AUTO_POST],
  accountNames: { [POST_ACCOUNT_ID]: 'とりふね（constructor）' },
  accountProviders: {
    [POST_ACCOUNT_ID]: { provider: 'constructor', credentialConfigured: false },
  },
  publisherProviders: {},
  total: 1,
  page: 1,
  perPage: 20,
  permissions: ['social.read', 'social.write', 'social.delete'],
};

function renderPosts(overrides: Partial<SocialPostsProps> = {}): string {
  return renderToStaticMarkup(createElement(SocialPosts, { ...POSTS_BASE, ...overrides }));
}

describe('#6 SocialPosts は provider が constructor の予約の支度を自分のキーで判断する', () => {
  it('#6 publisherProviders が {} なら「配信 Plugin なし」の Badge が出る（回帰の守り）', () => {
    // 変更前も通る（`Object` 関数に `publish` が無いので偶然 `no_publisher` になる。設計 #6 の注）。
    expect(textOf(renderPosts())).toContain(NO_PUBLISHER_BADGE);
  });

  it('#6 自分のキー constructor の publisher があれば「配信 Plugin なし」の Badge が出ない', () => {
    const publisherProviders: SocialPostsProps['publisherProviders'] = Object.fromEntries([
      ['constructor', { label: 'C', manual: false, publish: true, credentialFieldKeys: [] }],
    ]);

    expect(textOf(renderPosts({ publisherProviders }))).not.toContain(NO_PUBLISHER_BADGE);
  });
});
