import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ApiTokenResponse } from '@/api/schemas/api-token';
import { ApiSettings } from './api-settings';

// 部品が将来 `useRouter` を使っても App Router の外で例外にならないよう差し替える
// （`ui/social/social-accounts.test.ts` と同じ形）。
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

/**
 * 設定 → API のサイト（053-site-scoped-social 設計 §9.2・§9.2.1、受け入れ条件 #70・#92）。
 *
 * * #70 発行フォームの「サイト」の `Select`、サイトを選んだ間の `disabled` のチェックボックス、
 *   一覧の「サイト」列（名前／「共通」／「削除されたサイト」／「サイト専用」）
 * * #92 「サイトを変える」の出し分けと Modal、純関数 `changeTokenSiteRequestBody`
 *
 * 新しい props（`sites` / `siteTokenScopes` / `initialSiteId` / `initialTokens` /
 * `initialChangingTokenId`）は設計 §9.2 と実装プラン T25・§8 の 11 から写す。まだ型に無いので、
 * 部品を**テストの中で写した props の型**として読む。`initialTokens` を渡せば読み込みの要求を出さずに
 * 一覧を描く（`useEffect` は静的な描画では走らない。実装プラン §2 のテストの方法）。
 *
 * `changeTokenSiteRequestBody` は `ui/settings/api-token-site.ts`（新規。実装プラン §8 の 13）に置く。
 * 未作成のモジュールなので、**指定子を `string` 型の定数に置いた動的 import** で読む（§8 の 19）。
 *
 * 単体テストの環境には DOM が無く、ボタンを押して Modal を開けない。「サイトを変える」の Modal は
 * `initialChangingTokenId` で開いた状態で描く。選び直し・送信・読み直しは E2E（#93）が見る。
 */

/* -------------------------------------------------------------------------- */
/* 型（設計 §9.2 から写す）                                                       */
/* -------------------------------------------------------------------------- */

type SiteStatus = 'active' | 'paused' | 'archived';

interface SiteOption {
  readonly id: string;
  readonly name: string;
  readonly status: SiteStatus;
}

interface ApiSettingsSiteProps {
  readonly scopeCandidates: readonly string[];
  readonly corsOrigins: readonly string[];
  readonly sites: readonly SiteOption[];
  readonly siteTokenScopes: readonly string[];
  readonly initialSiteId?: string | null;
  readonly initialTokens?: readonly ApiTokenResponse[];
  readonly initialChangingTokenId?: string;
}

const Component = ApiSettings as unknown as ComponentType<ApiSettingsSiteProps>;

interface ChangeTokenSiteRequestBody {
  readonly siteId: string | null;
  readonly scopes?: readonly string[];
}

interface ApiTokenSiteModule {
  changeTokenSiteRequestBody(input: {
    readonly siteId: string | null;
    readonly currentScopes: readonly string[];
    readonly siteTokenScopes: readonly string[];
  }): ChangeTokenSiteRequestBody;
}

/** 未作成のモジュールを型検査に掛けないため、指定子は定数に置く。 */
const API_TOKEN_SITE_MODULE: string = '@/ui/settings/api-token-site';

async function load(): Promise<ApiTokenSiteModule> {
  return (await import(/* @vite-ignore */ API_TOKEN_SITE_MODULE)) as ApiTokenSiteModule;
}

/* -------------------------------------------------------------------------- */
/* データ                                                                       */
/* -------------------------------------------------------------------------- */

/** Server Component が渡す `SITE_TOKEN_SCOPES`（設計 §7.2。部品は一覧を持たない）。 */
const SITE_TOKEN_SCOPES = ['social.read', 'social.write', 'social.delete', 'social.approve'];

/** 発行者（管理者）が持つ Permission の一部。SNS 以外を含める。 */
const SCOPE_CANDIDATES = [
  'site.read',
  'site.write',
  'social.read',
  'social.write',
  'social.delete',
  'social.approve',
  'token.manage',
];

const NON_SITE_SCOPES = SCOPE_CANDIDATES.filter((scope) => !SITE_TOKEN_SCOPES.includes(scope));

const SITE_A_ID = '01900000-0000-7000-8000-0000000053a1';
const SITE_B_ID = '01900000-0000-7000-8000-0000000053b1';
const SITE_C_ID = '01900000-0000-7000-8000-0000000053c1';
const SITE_UNKNOWN_ID = '01900000-0000-7000-8000-0000000053f1';

const SITE_A: SiteOption = { id: SITE_A_ID, name: 'Alpha Shop', status: 'active' };
const SITE_B: SiteOption = { id: SITE_B_ID, name: 'Bravo Blog', status: 'paused' };
const SITE_C: SiteOption = { id: SITE_C_ID, name: 'Charlie Lab', status: 'archived' };

/** Server Component が渡す並び（設計 §9.2 → §9.1.5 と同じ 2 回）。 */
const SITES: readonly SiteOption[] = [SITE_A, SITE_B, SITE_C];

const REVOKED_AT = '2026-10-01T00:00:00.000Z';

function token(
  id: string,
  name: string,
  site: { readonly siteId: string | null; readonly siteScoped: boolean },
  scopes: readonly string[],
  revokedAt: string | null = null,
): ApiTokenResponse {
  return {
    id,
    name,
    prefix: `tfp_${id.slice(-4)}`,
    scopes,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt,
    createdAt: '2026-10-01T00:00:00.000Z',
    siteId: site.siteId,
    siteScoped: site.siteScoped,
  };
}

const TOKEN_A = token(
  '01900000-0000-7000-8000-00000053aa01',
  'サイトAの連携',
  { siteId: SITE_A_ID, siteScoped: true },
  ['social.read', 'social.write'],
);
const TOKEN_COMMON = token(
  '01900000-0000-7000-8000-00000053cc01',
  '共通の連携',
  { siteId: null, siteScoped: false },
  ['social.read', 'site.read'],
);
/** サイトの削除で失効したサイトのトークン（`siteScoped: true`・`siteId: null`）。 */
const TOKEN_SITE_DELETED = token(
  '01900000-0000-7000-8000-00000053dd01',
  '消えたサイトの連携',
  { siteId: null, siteScoped: true },
  ['social.read'],
  REVOKED_AT,
);
const TOKEN_UNKNOWN = token(
  '01900000-0000-7000-8000-00000053ff01',
  '引けないサイトの連携',
  { siteId: SITE_UNKNOWN_ID, siteScoped: true },
  ['social.read'],
);
const TOKEN_REVOKED = token(
  '01900000-0000-7000-8000-00000053ee01',
  '失効済みの古い連携',
  { siteId: null, siteScoped: false },
  ['social.read'],
  REVOKED_AT,
);

const TOKENS: readonly ApiTokenResponse[] = [
  TOKEN_A,
  TOKEN_COMMON,
  TOKEN_SITE_DELETED,
  TOKEN_UNKNOWN,
  TOKEN_REVOKED,
];

const BASE: ApiSettingsSiteProps = {
  scopeCandidates: SCOPE_CANDIDATES,
  corsOrigins: [],
  sites: SITES,
  siteTokenScopes: SITE_TOKEN_SCOPES,
  initialTokens: TOKENS,
};

/* 設計 §9.2・§9.2.1 の文言 */
const SITE_LABEL = 'サイト';
const COMMON_OPTION = '共通（サイトに紐づけない）';
const SITE_DESCRIPTION =
  'サイトを選ぶと、このトークンはそのサイトの SNS アカウントと共通の SNS アカウントだけを使えます。付けられる権限は SNS の 4 つだけです。サイトは後から変えられます。';
const COMMON_INFO = '共通のトークンは、サイトに紐づいていない SNS アカウントだけを使えます。';
const COMMON_LABEL = '共通';
const SITE_DELETED_LABEL = '削除されたサイト';
const UNNAMED_LABEL = 'サイト専用';
const CHANGE_BUTTON = 'サイトを変える';
const CHANGE_TITLE = 'トークンのサイトを変える';
const REMOVED_WARNING_PREFIX = 'このサイトに紐づけると、次の権限が外れます：';
const EMPTY_SCOPES_NOTE = '権限が 1 つも残らないため、このトークンでは何もできなくなります。';
const MOVE_NOTE =
  'このトークンが共通のアカウントへ登録した投稿は、変更後の区画へ移ります。サイト専用のアカウントと、このトークンが作ったアカウントは元のサイトに残り、変更後は見えなくなることがあります。';

/* -------------------------------------------------------------------------- */
/* 描画と HTML の読み方                                                           */
/* -------------------------------------------------------------------------- */

function render(overrides: Partial<ApiSettingsSiteProps> = {}): string {
  const props: ApiSettingsSiteProps = { ...BASE, ...overrides };
  return renderToStaticMarkup(createElement(Component, props));
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function headers(html: string): string[] {
  return [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((match) =>
    textOf(match[1] as string).trim(),
  );
}

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

/** トークンの名前で選んだ行。ちょうど 1 行あることも確かめる。 */
function rowOf(html: string, name: string): string {
  const rows = bodyRows(html).filter((row) => textOf(row).includes(name));
  expect(rows, `名前「${name}」の行`).toHaveLength(1);
  return rows[0] as string;
}

function cellsOf(row: string): string[] {
  return [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((match) =>
    textOf(match[1] as string).trim(),
  );
}

function siteCellOf(html: string, name: string): string {
  const index = headers(html).indexOf(SITE_LABEL);
  expect(index, '「サイト」の見出し').toBeGreaterThanOrEqual(0);
  return cellsOf(rowOf(html, name))[index] ?? '';
}

function balancedDiv(html: string, start: number): string {
  const tag = /<div\b|<\/div>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let match = tag.exec(html); match !== null; match = tag.exec(html)) {
    depth += match[0] === '</div>' ? -1 : 1;
    if (depth === 0) {
      return html.slice(start, match.index + '</div>'.length);
    }
  }
  return html.slice(start);
}

function dialogOf(html: string, title: string): string | undefined {
  for (const match of html.matchAll(/<div\b[^>]*>/g)) {
    const tag = match[0];
    if (!/\brole="dialog"/.test(tag)) continue;
    const label = /\baria-label="([^"]*)"/.exec(tag)?.[1];
    if (label !== undefined && textOf(label) === title) {
      return balancedDiv(html, match.index);
    }
  }
  return undefined;
}

/** `role="dialog"` の部分を取り除いた HTML（ページ本体だけを見るため）。 */
function withoutDialogs(html: string): string {
  let rest = html;
  for (;;) {
    const match = /<div\b[^>]*\brole="dialog"[^>]*>/.exec(rest);
    if (match === null) return rest;
    const dialog = balancedDiv(rest, match.index);
    rest = rest.slice(0, match.index) + rest.slice(match.index + dialog.length);
  }
}

interface OptionInfo {
  readonly value: string;
  readonly text: string;
  readonly selected: boolean;
}

function optionsOf(select: string): OptionInfo[] {
  return [...select.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map((match) => {
    const attributes = match[1] as string;
    const text = textOf(match[2] as string).trim();
    const value = /\bvalue="([^"]*)"/.exec(attributes)?.[1];
    return {
      value: value === undefined ? text : textOf(value),
      text,
      selected: /\sselected(?:=""|\s|$)/.test(attributes),
    };
  });
}

/** 選ばれている値。`selected` の付いた選択肢が無ければ先頭（単一選択の `<select>` の既定）。 */
function selectedValue(select: string): string | undefined {
  const options = optionsOf(select);
  return (options.find((option) => option.selected) ?? options[0])?.value;
}

function openTagOf(select: string): string {
  return /^<select\b[^>]*>/.exec(select)?.[0] ?? '';
}

/** ラベルで選んだ `<select>`（`<label for>` と `id` の対応、または `aria-label`）。 */
function selectByLabel(html: string, label: string): string | undefined {
  const selects = [...html.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g)].map((match) => match[0]);
  for (const match of html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/g)) {
    const forId = /\bfor="([^"]+)"/.exec(match[1] as string)?.[1];
    const text = textOf(match[2] as string)
      .replace(/\*\s*$/, '')
      .trim();
    if (forId === undefined || text !== label) continue;
    const found = selects.find((select) =>
      new RegExp(`\\bid="${escapeRegExp(forId)}"`).test(openTagOf(select)),
    );
    if (found !== undefined) return found;
  }
  return selects.find((select) => {
    const ariaLabel = /\baria-label="([^"]*)"/.exec(openTagOf(select))?.[1];
    return ariaLabel !== undefined && textOf(ariaLabel) === label;
  });
}

/** 発行フォームの「サイト」の Select（Modal の中は見ない）。 */
function issueSiteSelect(overrides: Partial<ApiSettingsSiteProps> = {}): string {
  const select = selectByLabel(withoutDialogs(render(overrides)), SITE_LABEL);
  expect(select, '発行フォームの「サイト」の Select').toBeDefined();
  return select ?? '';
}

/** 権限のチェックボックスの `<input>`。見える文字（`<code>`）がちょうど `scope` の `<label>` の中から引く。 */
function checkboxOf(html: string, scope: string): string | undefined {
  for (const match of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)) {
    const inner = match[1] as string;
    if (textOf(inner).trim() !== scope) continue;
    const input = /<input\b[^>]*type="checkbox"[^>]*>/.exec(inner)?.[0];
    if (input !== undefined) return input;
  }
  return undefined;
}

function isDisabled(tag: string): boolean {
  return /\sdisabled(?:=""|\s|>|\/)/.test(tag);
}

function isChecked(tag: string): boolean {
  return /\schecked(?:=""|\s|>|\/)/.test(tag);
}

function hasButton(html: string, label: string): boolean {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].some(
    (match) => textOf(match[1] as string).trim() === label,
  );
}

/* -------------------------------------------------------------------------- */
/* #70 発行フォームの「サイト」                                                    */
/* -------------------------------------------------------------------------- */

describe('#70 発行フォームの「サイト」の Select', () => {
  it('#70 発行フォームに「サイト」の Select がある', () => {
    expect(selectByLabel(withoutDialogs(render()), SITE_LABEL)).toBeDefined();
  });

  it('#70 先頭の選択肢は「共通（サイトに紐づけない）」で値は空', () => {
    const first = optionsOf(issueSiteSelect())[0];

    expect(first?.text).toBe(COMMON_OPTION);
    expect(first?.value).toBe('');
  });

  it('#70 既定で「共通」が選ばれている', () => {
    expect(selectedValue(issueSiteSelect())).toBe('');
  });

  it('#70 共通の後の選択肢は active / paused のサイトだけ（アーカイブを除く。渡された順）', () => {
    const options = optionsOf(issueSiteSelect()).slice(1);

    expect(options.map((option) => option.value)).toEqual([SITE_A_ID, SITE_B_ID]);
    expect(options.map((option) => option.text)).toEqual([SITE_A.name, SITE_B.name]);
  });

  it('#70 説明の文言がある', () => {
    expect(textOf(withoutDialogs(render()))).toContain(SITE_DESCRIPTION);
  });

  it('#70 共通を選んでいるときは補足「共通のトークンは、…」がある', () => {
    expect(textOf(withoutDialogs(render()))).toContain(COMMON_INFO);
  });

  it('#70 sites が空（site.read が無い）なら選択肢は「共通」だけ', () => {
    const options = optionsOf(issueSiteSelect({ sites: [] }));

    expect(options.map((option) => option.value)).toEqual(['']);
  });

  it('#70 サイトを選んだ状態（initialSiteId）ではそのサイトが選ばれている', () => {
    expect(selectedValue(issueSiteSelect({ initialSiteId: SITE_A_ID }))).toBe(SITE_A_ID);
  });

  it('#70 サイトを選んだ状態では共通の補足が無い', () => {
    // 前提：サイトを選んだ状態で描けている（空振りしない）。
    expect(selectedValue(issueSiteSelect({ initialSiteId: SITE_A_ID }))).toBe(SITE_A_ID);
    expect(textOf(withoutDialogs(render({ initialSiteId: SITE_A_ID })))).not.toContain(COMMON_INFO);
  });
});

describe('#70 サイトを選んでいる間の権限のチェックボックス', () => {
  it('#70 前提：権限の候補ごとにチェックボックスがある', () => {
    const html = withoutDialogs(render());

    for (const scope of SCOPE_CANDIDATES) {
      expect(checkboxOf(html, scope), scope).toBeDefined();
    }
  });

  it('#70 共通のときはどのチェックボックスも disabled でない', () => {
    const html = withoutDialogs(render());

    for (const scope of SCOPE_CANDIDATES) {
      expect(isDisabled(checkboxOf(html, scope) ?? ''), scope).toBe(false);
    }
  });

  it.each(NON_SITE_SCOPES)(
    '#70 サイトを選んだ状態では SITE_TOKEN_SCOPES に無い %s が disabled',
    (scope) => {
      const html = withoutDialogs(render({ initialSiteId: SITE_A_ID }));
      const input = checkboxOf(html, scope);

      expect(input, scope).toBeDefined();
      expect(isDisabled(input ?? '')).toBe(true);
    },
  );

  it.each(NON_SITE_SCOPES)(
    '#70 サイトを選んだ状態では SITE_TOKEN_SCOPES に無い %s にチェックが無い',
    (scope) => {
      const html = withoutDialogs(render({ initialSiteId: SITE_A_ID }));

      expect(isChecked(checkboxOf(html, scope) ?? '')).toBe(false);
    },
  );

  it.each(SITE_TOKEN_SCOPES)(
    '#70 サイトを選んだ状態でも SITE_TOKEN_SCOPES の %s は disabled でない',
    (scope) => {
      const html = withoutDialogs(render({ initialSiteId: SITE_A_ID }));
      const input = checkboxOf(html, scope);

      expect(input, scope).toBeDefined();
      expect(isDisabled(input ?? '')).toBe(false);
    },
  );

  it('#70 disabled にする基準は props の siteTokenScopes（部品に一覧を持たない）', () => {
    // 判別力：siteTokenScopes を狭めると、外した social.approve も disabled になる。
    const html = withoutDialogs(
      render({
        initialSiteId: SITE_A_ID,
        siteTokenScopes: ['social.read', 'social.write', 'social.delete'],
      }),
    );

    expect(isDisabled(checkboxOf(html, 'social.approve') ?? '')).toBe(true);
    expect(isDisabled(checkboxOf(html, 'social.read') ?? '')).toBe(false);
  });
});

describe('#70 一覧の「サイト」列', () => {
  it('#70 「サイト」は「名前」のすぐ右にある', () => {
    const list = headers(withoutDialogs(render()));

    expect(list.indexOf('名前')).toBeGreaterThanOrEqual(0);
    expect(list.indexOf(SITE_LABEL)).toBe(list.indexOf('名前') + 1);
  });

  it('#70 サイト A のトークンはサイト A の名前', () => {
    expect(siteCellOf(render(), TOKEN_A.name)).toBe(SITE_A.name);
  });

  it('#70 共通のトークンは「共通」', () => {
    expect(siteCellOf(render(), TOKEN_COMMON.name)).toBe(COMMON_LABEL);
  });

  it('#70 siteScoped: true・siteId: null は「削除されたサイト」', () => {
    expect(siteCellOf(render(), TOKEN_SITE_DELETED.name)).toBe(SITE_DELETED_LABEL);
  });

  it('#70 名前を引けないサイトのトークンは「サイト専用」', () => {
    expect(siteCellOf(render(), TOKEN_UNKNOWN.name)).toBe(UNNAMED_LABEL);
  });

  it('#70 失効した共通のトークンも「共通」', () => {
    expect(siteCellOf(render(), TOKEN_REVOKED.name)).toBe(COMMON_LABEL);
  });

  it('#70 initialTokens を渡すと、読み込みを待たずに一覧が描かれる', () => {
    const html = render();

    for (const target of TOKENS) {
      expect(textOf(html), target.name).toContain(target.name);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #92 「サイトを変える」                                                         */
/* -------------------------------------------------------------------------- */

function changeDialog(target: ApiTokenResponse, overrides: Partial<ApiSettingsSiteProps> = {}) {
  const html = render({
    initialTokens: [...TOKENS.filter((row) => row.id !== target.id), target],
    initialChangingTokenId: target.id,
    ...overrides,
  });
  const dialog = dialogOf(html, CHANGE_TITLE);
  expect(dialog, '「トークンのサイトを変える」の Modal').toBeDefined();
  return dialog ?? '';
}

function changeSelect(target: ApiTokenResponse): string {
  const select = /<select\b[^>]*>[\s\S]*?<\/select>/.exec(changeDialog(target))?.[0];
  expect(select, 'Modal の Select').toBeDefined();
  return select ?? '';
}

describe('#92 「サイトを変える」の出し分け', () => {
  it('#92 失効していないトークンの行には「サイトを変える」がある', () => {
    const html = withoutDialogs(render());

    for (const target of [TOKEN_A, TOKEN_COMMON, TOKEN_UNKNOWN]) {
      expect(hasButton(rowOf(html, target.name), CHANGE_BUTTON), target.name).toBe(true);
    }
  });

  it('#92 失効したトークンの行には「サイトを変える」が無い', () => {
    const html = withoutDialogs(render());

    for (const target of [TOKEN_REVOKED, TOKEN_SITE_DELETED]) {
      expect(hasButton(rowOf(html, target.name), CHANGE_BUTTON), target.name).toBe(false);
    }
  });

  it('#92 「サイトを変える」は「失効させる」の左にある', () => {
    const row = rowOf(withoutDialogs(render()), TOKEN_A.name);
    const change = row.search(new RegExp(`>\\s*${escapeRegExp(CHANGE_BUTTON)}\\s*<`));
    const revoke = row.search(/>\s*失効させる\s*</);

    expect(change).toBeGreaterThanOrEqual(0);
    expect(revoke).toBeGreaterThan(change);
  });

  it('#92 既定（initialChangingTokenId なし）では Modal は閉じている', () => {
    expect(dialogOf(render(), CHANGE_TITLE)).toBeUndefined();
  });
});

describe('#92 「トークンのサイトを変える」の Modal', () => {
  it('#92 サイト A のトークンで開くと今のサイト（A）が選ばれている', () => {
    expect(selectedValue(changeSelect(TOKEN_A))).toBe(SITE_A_ID);
  });

  it('#92 共通のトークンで開くと「共通」（値は空）が選ばれている', () => {
    expect(selectedValue(changeSelect(TOKEN_COMMON))).toBe('');
  });

  it('#92 選択肢は「共通」と active / paused のサイト', () => {
    const options = optionsOf(changeSelect(TOKEN_A));

    expect(options.map((option) => option.value)).toEqual(['', SITE_A_ID, SITE_B_ID]);
    expect(options[0]?.text).toBe(COMMON_OPTION);
  });

  it('#92 裁定 10 の注意（共通のアカウントへ登録した投稿が移る）がある', () => {
    expect(textOf(changeDialog(TOKEN_A))).toContain(MOVE_NOTE);
  });

  it('#92 「キャンセル」と「変える」がある', () => {
    const dialog = changeDialog(TOKEN_A);

    expect(hasButton(dialog, 'キャンセル')).toBe(true);
    expect(hasButton(dialog, '変える')).toBe(true);
  });

  it('#92 選んだ先がサイトで今の Scope が SNS だけなら、権限が外れる注意は無い', () => {
    expect(textOf(changeDialog(TOKEN_A))).not.toContain(REMOVED_WARNING_PREFIX);
  });

  it('#92 選んだ先が共通なら、SNS 以外の Scope があっても権限が外れる注意は無い', () => {
    expect(textOf(changeDialog(TOKEN_COMMON))).not.toContain(REMOVED_WARNING_PREFIX);
  });

  /**
   * 選んだ先がサイトで、今の Scope に SNS 以外がある状態。Modal の選び直しは静的な描画ではできない
   * ので、**今のサイトが A で Scope に `site.read` を持つ行**を渡して「選んだ先（既定＝今の値）が
   * サイト」の状態を作る（DB の CHECK はこの行を許さないが、部品の判定は設計 §9.2.1 の
   * 「選んだ先がサイトで、今の Scope に SNS 以外のものがあれば」だけで決まる）。
   */
  it('#92 選んだ先がサイトで今の Scope に site.read があれば「site.read」が外れる注意がある', () => {
    const target = token(
      '01900000-0000-7000-8000-00000053ab01',
      'site.read を持つ行',
      { siteId: SITE_A_ID, siteScoped: true },
      ['social.read', 'site.read'],
    );
    const text = textOf(changeDialog(target));

    expect(text).toContain(`${REMOVED_WARNING_PREFIX}site.read`);
    expect(text).not.toContain(EMPTY_SCOPES_NOTE);
  });

  it('#92 外した結果 Scope が空になるなら「権限が 1 つも残らないため、…」を添える', () => {
    const target = token(
      '01900000-0000-7000-8000-00000053ae01',
      'site.read だけの行',
      { siteId: SITE_A_ID, siteScoped: true },
      ['site.read'],
    );
    const text = textOf(changeDialog(target));

    expect(text).toContain(`${REMOVED_WARNING_PREFIX}site.read`);
    expect(text).toContain(EMPTY_SCOPES_NOTE);
  });
});

describe('#92 changeTokenSiteRequestBody', () => {
  it("#92 サイトへ・今の Scope ['social.read', 'site.read'] → { siteId, scopes: ['social.read'] }", async () => {
    const { changeTokenSiteRequestBody } = await load();

    expect(
      changeTokenSiteRequestBody({
        siteId: SITE_A_ID,
        currentScopes: ['social.read', 'site.read'],
        siteTokenScopes: SITE_TOKEN_SCOPES,
      }),
    ).toStrictEqual({ siteId: SITE_A_ID, scopes: ['social.read'] });
  });

  it('#92 サイトへ・今の Scope が SNS だけ → scopes を含まない', async () => {
    const { changeTokenSiteRequestBody } = await load();
    const body = changeTokenSiteRequestBody({
      siteId: SITE_A_ID,
      currentScopes: ['social.read', 'social.write'],
      siteTokenScopes: SITE_TOKEN_SCOPES,
    });

    expect(body).toStrictEqual({ siteId: SITE_A_ID });
    expect(Object.keys(body)).not.toContain('scopes');
  });

  it('#92 共通へ → { siteId: null }（SNS 以外の Scope があっても scopes を含まない）', async () => {
    const { changeTokenSiteRequestBody } = await load();

    expect(
      changeTokenSiteRequestBody({
        siteId: null,
        currentScopes: ['social.read', 'site.read'],
        siteTokenScopes: SITE_TOKEN_SCOPES,
      }),
    ).toStrictEqual({ siteId: null });
  });

  it('#92 サイトへ・今の Scope が SNS 以外だけ → scopes は空（外れるものがあるので送る）', async () => {
    const { changeTokenSiteRequestBody } = await load();

    expect(
      changeTokenSiteRequestBody({
        siteId: SITE_A_ID,
        currentScopes: ['site.read'],
        siteTokenScopes: SITE_TOKEN_SCOPES,
      }),
    ).toStrictEqual({ siteId: SITE_A_ID, scopes: [] });
  });

  it('#92 scopes は「今の Scope ∩ siteTokenScopes」（並びは問わない）', async () => {
    const { changeTokenSiteRequestBody } = await load();
    const body = changeTokenSiteRequestBody({
      siteId: SITE_B_ID,
      currentScopes: ['site.read', 'social.write', 'token.manage', 'social.approve'],
      siteTokenScopes: SITE_TOKEN_SCOPES,
    });

    expect(body.siteId).toBe(SITE_B_ID);
    expect([...(body.scopes ?? [])].sort()).toEqual(['social.approve', 'social.write']);
  });

  it('#92 交差の基準は引数の siteTokenScopes', async () => {
    const { changeTokenSiteRequestBody } = await load();

    expect(
      changeTokenSiteRequestBody({
        siteId: SITE_A_ID,
        currentScopes: ['social.read', 'social.approve'],
        siteTokenScopes: ['social.read'],
      }),
    ).toStrictEqual({ siteId: SITE_A_ID, scopes: ['social.read'] });
  });
});
