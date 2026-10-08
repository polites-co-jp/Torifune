import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { buildCreateAccountRequest } from './credential-form';
import { SocialAccounts, type AccountRow, type SocialAccountsProps } from './social-accounts';

// 部品は保存・消去の後に `router.refresh()` を呼ぶ（039 設計 §7.3.4）。
// `useRouter` は App Router の外では例外を投げるので差し替える（`social-accounts.test.ts` と同じ）。
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

/**
 * `/social` のアカウント一覧のサイト（053-site-scoped-social 設計 §9.1、受け入れ条件 #65〜#69）。
 *
 * * #65 「サイト」の見出しの位置と、行のサイトの表示（名前／「共通」／「サイト専用」／「（アーカイブ）」）
 * * #66 追加の Modal の「サイト」の `Select`（`name="siteId"`）
 * * #67 `buildCreateAccountRequest` の `siteId`
 * * #68 行の「サイト」ボタンの出し分けと、「サイトの紐づけを変える」の Modal
 * * #69 「サイトで絞り込む」
 *
 * 新しい props（`sites` / `canReadSites` / `initialSiteEditingAccountId` / `initialSiteFilter`）と
 * `AccountRow.siteId` は設計 §9.1.5 と実装プラン T24・§8 の 11 から写す。まだ型に無いので、
 * 部品を**テストの中で写した props の型**として読む（型検査を未実装の props に掛けない）。
 *
 * 単体テストの環境には DOM が無く、ボタンを押して Modal を開けない。設計 §9.1.5 の
 * テストの口（`initialCreating` / `initialSiteEditingAccountId` / `initialSiteFilter`）で開いた・
 * 絞った状態を描く。保存の要求（`PATCH { siteId }`）と絞り込みの切り替えは E2E（#76）が見る。
 *
 * 051（「アカウントID」の列）が取り込まれていてもいなくても通るように、#65 の見出しの位置は
 * 「アカウントID」があればその後、無ければ「ハンドル」の後、と書く（実装プラン「051 の取り込みの確認」）。
 */

/* -------------------------------------------------------------------------- */
/* 型（設計 §9.1.5 から写す）                                                     */
/* -------------------------------------------------------------------------- */

type SiteStatus = 'active' | 'paused' | 'archived';

interface SiteOption {
  readonly id: string;
  readonly name: string;
  readonly status: SiteStatus;
}

type SiteAccountRow = AccountRow & { readonly siteId?: string | null };

type SiteProps = Omit<SocialAccountsProps, 'initialAccounts'> & {
  readonly initialAccounts: readonly SiteAccountRow[];
  readonly sites?: readonly SiteOption[];
  readonly canReadSites?: boolean;
  readonly initialSiteEditingAccountId?: string;
  readonly initialSiteFilter?: string;
};

const Component = SocialAccounts as unknown as ComponentType<SiteProps>;

/* -------------------------------------------------------------------------- */
/* データ                                                                       */
/* -------------------------------------------------------------------------- */

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

const SITE_A_ID = '01900000-0000-7000-8000-0000000053a1';
const SITE_B_ID = '01900000-0000-7000-8000-0000000053b1';
const SITE_C_ID = '01900000-0000-7000-8000-0000000053c1';
/** `sites` に無いサイト（`site.read` で引けない・一覧に無い）。 */
const SITE_UNKNOWN_ID = '01900000-0000-7000-8000-0000000053f1';

const SITE_A: SiteOption = { id: SITE_A_ID, name: 'Alpha Shop', status: 'active' };
const SITE_B: SiteOption = { id: SITE_B_ID, name: 'Bravo Blog', status: 'paused' };
const SITE_C: SiteOption = { id: SITE_C_ID, name: 'Charlie Lab', status: 'archived' };

/**
 * Server Component が渡す並び（設計 §9.1.5）：`active` / `paused` を名前順、続けてアーカイブを名前順。
 * 部品は並べ替えずにこの順を使い、追加の Modal ではアーカイブを除く。
 */
const SITES: readonly SiteOption[] = [SITE_A, SITE_B, SITE_C];

function account(id: string, displayName: string, siteId?: string | null): SiteAccountRow {
  const base: AccountRow = {
    id,
    provider: 'x',
    displayName,
    handle: `@${id.slice(-4)}`,
    status: 'connected',
    credentialConfigured: true,
  };
  return siteId === undefined ? base : { ...base, siteId };
}

const ACC_A = account('01900000-0000-7000-8000-00000053aa01', 'アルファ公式', SITE_A_ID);
const ACC_A2 = account('01900000-0000-7000-8000-00000053aa02', 'アルファ広報', SITE_A_ID);
const ACC_COMMON = account('01900000-0000-7000-8000-00000053cc01', '共用の窓口', null);
/** `siteId` を持たない行（省略は共通と同じ。設計 §9.1.5）。 */
const ACC_OMITTED = account('01900000-0000-7000-8000-00000053cc02', '古い行');
const ACC_UNKNOWN = account(
  '01900000-0000-7000-8000-00000053ff01',
  '引けない紐づけ',
  SITE_UNKNOWN_ID,
);
const ACC_ARCHIVED = account('01900000-0000-7000-8000-00000053ac01', 'チャーリー公式', SITE_C_ID);

const BASE: SiteProps = {
  initialAccounts: [ACC_A, ACC_COMMON, ACC_OMITTED, ACC_UNKNOWN, ACC_ARCHIVED],
  permissions: ['social.read', 'social.write', 'social.delete'],
  providers: PROVIDERS,
  sites: SITES,
  canReadSites: true,
};

/* 設計 §9.1 の文言 */
const SITE_HEADER = 'サイト';
const COMMON_LABEL = '共通';
const COMMON_OPTION = '共通（どのサイトのトークンからも使える）';
const UNNAMED_LABEL = 'サイト専用';
const ARCHIVED_SUFFIX = '（アーカイブ）';
const SELECT_DESCRIPTION =
  'サイトを選ぶと、そのサイトに紐づいた API トークンからだけ使えます。管理画面からはいつでも使えます。';
const SELECT_NO_PERMISSION = 'サイトの一覧を見る権限が無いため、共通で登録します。';
const CHANGE_BUTTON = 'サイト';
const CHANGE_TITLE = 'サイトの紐づけを変える';
const CHANGE_WARNING =
  'このアカウントの投稿（予約・承認待ちを含む）は、変更後のサイトのトークンからだけ見えるようになります。登録済みの予約はそのまま配信されます。';
const FILTER_LABEL = 'サイトで絞り込む';
const FILTER_ALL = 'すべて';
const CREATE_TITLE = 'SNSアカウントを追加';

/* -------------------------------------------------------------------------- */
/* 描画と HTML の読み方                                                           */
/* -------------------------------------------------------------------------- */

function render(overrides: Partial<SiteProps> = {}): string {
  const props: SiteProps = { ...BASE, ...overrides };
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

/** 見出し（`<th>` のテキスト）の並び。 */
function headers(html: string): string[] {
  return [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((match) =>
    textOf(match[1] as string).trim(),
  );
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

/** 表示名で選んだ行の HTML（無ければ undefined）。 */
function findRow(html: string, displayName: string): string | undefined {
  return bodyRows(html).find((row) => textOf(row).includes(displayName));
}

/** 表示名で選んだ行の HTML。ちょうど 1 行あることも確かめる。 */
function rowOf(html: string, displayName: string): string {
  const rows = bodyRows(html).filter((row) => textOf(row).includes(displayName));
  expect(rows, `表示名「${displayName}」の行`).toHaveLength(1);
  return rows[0] as string;
}

/** 行の各セル（`<td>`）のテキスト。 */
function cellsOf(row: string): string[] {
  return [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((match) =>
    textOf(match[1] as string).trim(),
  );
}

/** 「サイト」列のセルのテキスト。 */
function siteCellOf(html: string, displayName: string): string {
  const index = headers(html).indexOf(SITE_HEADER);
  expect(index, '「サイト」の見出し').toBeGreaterThanOrEqual(0);
  return cellsOf(rowOf(html, displayName))[index] ?? '';
}

/** `start` の位置で始まる `<div …>` を、対応する `</div>` まで切り出す。 */
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

/** `aria-label` が `title` の `role="dialog"` の中身（無ければ undefined）。 */
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

/**
 * 選ばれている値。`selected` の付いた選択肢が無ければ先頭（単一選択の `<select>` の既定。
 * 制御しない `<select>` でも同じ結果になる）。
 */
function selectedValue(select: string): string | undefined {
  const options = optionsOf(select);
  return (options.find((option) => option.selected) ?? options[0])?.value;
}

/** `<select …>` の開始タグ。 */
function openTagOf(select: string): string {
  return /^<select\b[^>]*>/.exec(select)?.[0] ?? '';
}

function isDisabled(openTag: string): boolean {
  return /\sdisabled(?:=""|\s|>|\/)/.test(openTag);
}

/** `name` 属性で選んだ `<select>`（無ければ undefined）。 */
function selectByName(html: string, name: string): string | undefined {
  return [...html.matchAll(/<select\b[^>]*>[\s\S]*?<\/select>/g)]
    .map((match) => match[0])
    .find((select) => new RegExp(`\\bname="${escapeRegExp(name)}"`).test(openTagOf(select)));
}

/**
 * ラベルで選んだ `<select>`（無ければ undefined）。
 *
 * `<label for="X">ラベル</label>` と `id="X"` の対応（`FormField`）、または `aria-label` で引く。
 * `useId` の値は決め打ちしない。
 */
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

/** `<button>` の見える文字ちょうどが `label` のものがあるか。 */
function hasButton(html: string, label: string): boolean {
  return [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].some(
    (match) => textOf(match[1] as string).trim() === label,
  );
}

/* -------------------------------------------------------------------------- */
/* #65 「サイト」の列                                                            */
/* -------------------------------------------------------------------------- */

describe('#65 「サイト」の列', () => {
  it('#65 見出しに「サイト」がちょうど 1 つある', () => {
    expect(headers(render()).filter((header) => header === SITE_HEADER)).toHaveLength(1);
  });

  it('#65 「サイト」は「アカウントID」（無ければ「ハンドル」）のすぐ後ろにある', () => {
    const list = headers(render());
    const anchor = list.includes('アカウントID') ? 'アカウントID' : 'ハンドル';

    expect(list.indexOf(anchor)).toBeGreaterThanOrEqual(0);
    expect(list.indexOf(SITE_HEADER)).toBe(list.indexOf(anchor) + 1);
  });

  it('#65 「サイト」は「資格情報」のすぐ前にある', () => {
    const list = headers(render());

    expect(list.indexOf('資格情報')).toBe(list.indexOf(SITE_HEADER) + 1);
  });

  it('#65 サイト A に紐づいた行はサイト A の名前', () => {
    expect(siteCellOf(render(), ACC_A.displayName)).toBe(SITE_A.name);
  });

  it('#65 siteId が null の行は「共通」', () => {
    expect(siteCellOf(render(), ACC_COMMON.displayName)).toBe(COMMON_LABEL);
  });

  it('#65 siteId を持たない行は「共通」', () => {
    expect(siteCellOf(render(), ACC_OMITTED.displayName)).toBe(COMMON_LABEL);
  });

  it('#65 sites に無いサイトに紐づいた行は「サイト専用」', () => {
    expect(siteCellOf(render(), ACC_UNKNOWN.displayName)).toBe(UNNAMED_LABEL);
  });

  it('#65 site.read が無い（sites が空・canReadSites が false）とサイトに紐づいた行は「サイト専用」', () => {
    const html = render({ sites: [], canReadSites: false });

    expect(siteCellOf(html, ACC_A.displayName)).toBe(UNNAMED_LABEL);
    // 共通の行は名前を引かなくても「共通」。
    expect(siteCellOf(html, ACC_COMMON.displayName)).toBe(COMMON_LABEL);
  });

  it('#65 アーカイブしたサイトに紐づいた行は名前に「（アーカイブ）」が添えられる', () => {
    const cell = siteCellOf(render(), ACC_ARCHIVED.displayName);

    expect(cell).toContain(SITE_C.name);
    expect(cell).toContain(ARCHIVED_SUFFIX);
    expect(cell.indexOf(SITE_C.name)).toBeLessThan(cell.indexOf(ARCHIVED_SUFFIX));
  });

  it('#65 アーカイブしていないサイトの行には「（アーカイブ）」が無い', () => {
    const html = render();

    expect(siteCellOf(html, ACC_A.displayName)).not.toContain(ARCHIVED_SUFFIX);
    expect(siteCellOf(html, ACC_COMMON.displayName)).not.toContain(ARCHIVED_SUFFIX);
  });

  it('#65 social.write を持たない閲覧者にも「サイト」の列が見える', () => {
    const html = render({ permissions: ['social.read'] });

    expect(headers(html)).toContain(SITE_HEADER);
    expect(siteCellOf(html, ACC_A.displayName)).toBe(SITE_A.name);
  });
});

/* -------------------------------------------------------------------------- */
/* #66 追加の Modal の「サイト」                                                  */
/* -------------------------------------------------------------------------- */

function createDialog(overrides: Partial<SiteProps> = {}): string {
  const dialog = dialogOf(render({ initialCreating: true, ...overrides }), CREATE_TITLE);
  expect(dialog, '追加の Modal').toBeDefined();
  return dialog ?? '';
}

function createSiteSelect(overrides: Partial<SiteProps> = {}): string {
  const select = selectByName(createDialog(overrides), 'siteId');
  expect(select, '追加の Modal の name="siteId" の Select').toBeDefined();
  return select ?? '';
}

describe('#66 追加の Modal の「サイト」の Select', () => {
  it('#66 追加の Modal に name="siteId" の Select がある', () => {
    expect(selectByName(createDialog(), 'siteId')).toBeDefined();
  });

  it('#66 先頭の選択肢は「共通（どのサイトのトークンからも使える）」で値は空', () => {
    const first = optionsOf(createSiteSelect())[0];

    expect(first?.text).toBe(COMMON_OPTION);
    expect(first?.value).toBe('');
  });

  it('#66 既定で「共通」が選ばれている', () => {
    expect(selectedValue(createSiteSelect())).toBe('');
  });

  it('#66 共通の後の選択肢は active / paused のサイトだけ（アーカイブを除く。渡された順）', () => {
    const values = optionsOf(createSiteSelect())
      .slice(1)
      .map((option) => option.value);

    expect(values).toEqual([SITE_A_ID, SITE_B_ID]);
  });

  it('#66 サイトの選択肢の文字はサイトの名前', () => {
    const texts = optionsOf(createSiteSelect())
      .slice(1)
      .map((option) => option.text);

    expect(texts).toEqual([SITE_A.name, SITE_B.name]);
  });

  it('#66 説明の文言がある', () => {
    expect(textOf(createDialog())).toContain(SELECT_DESCRIPTION);
  });

  it('#66 「サイト」の Select は「表示名」の欄より上にある', () => {
    const dialog = createDialog();
    const select = dialog.search(/<select\b[^>]*\bname="siteId"/);
    const displayName = dialog.search(/<input\b[^>]*\bname="displayName"/);

    expect(select).toBeGreaterThanOrEqual(0);
    expect(displayName).toBeGreaterThanOrEqual(0);
    expect(select).toBeLessThan(displayName);
  });

  it('#66 canReadSites が true なら Select は disabled でなく、権限が無い旨の説明も無い', () => {
    expect(isDisabled(openTagOf(createSiteSelect()))).toBe(false);
    expect(textOf(createDialog())).not.toContain(SELECT_NO_PERMISSION);
  });

  it('#66 canReadSites が false なら Select は disabled', () => {
    const select = createSiteSelect({ sites: [], canReadSites: false });

    expect(isDisabled(openTagOf(select))).toBe(true);
  });

  it('#66 canReadSites が false なら選択肢は「共通」だけ', () => {
    const options = optionsOf(createSiteSelect({ sites: [], canReadSites: false }));

    expect(options.map((option) => option.value)).toEqual(['']);
    expect(options[0]?.text).toBe(COMMON_OPTION);
  });

  it('#66 canReadSites が false なら「サイトの一覧を見る権限が無いため、共通で登録します。」がある', () => {
    expect(textOf(createDialog({ sites: [], canReadSites: false }))).toContain(
      SELECT_NO_PERMISSION,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #67 buildCreateAccountRequest の siteId                                       */
/* -------------------------------------------------------------------------- */

/**
 * 入力に足す `siteId` は実装プラン T23・§8 の 10 から写す（`siteId?: string | null`）。
 * まだ入力の型に無いので、オブジェクトを変数に置いてから渡す（余分なキーの検査に掛けない）。
 */
describe('#67 buildCreateAccountRequest が siteId を本文に入れる', () => {
  const baseInput = {
    provider: 'x',
    displayName: 'n',
    handle: 'h',
    values: {},
    credential: '',
  };

  it('#67 共通（siteId: null）なら本文の siteId が null', () => {
    const input = { ...baseInput, siteId: null };
    const body = buildCreateAccountRequest(PROVIDERS, input) as unknown as Record<string, unknown>;

    expect(Object.keys(body)).toContain('siteId');
    expect(body['siteId']).toBeNull();
  });

  it('#67 サイトを選んだら本文の siteId がそのサイトの ID', () => {
    const input = { ...baseInput, siteId: SITE_A_ID };
    const body = buildCreateAccountRequest(PROVIDERS, input) as unknown as Record<string, unknown>;

    expect(body['siteId']).toBe(SITE_A_ID);
  });

  it('#67 siteId を渡さなければ本文に siteId のキーは無い（既存の呼び出しの本文を変えない）', () => {
    const body = buildCreateAccountRequest(PROVIDERS, baseInput) as unknown as Record<
      string,
      unknown
    >;

    expect(Object.keys(body)).not.toContain('siteId');
  });

  it('#67 siteId を足しても他の項目は変わらない', () => {
    const input = { ...baseInput, siteId: SITE_A_ID };
    const withSite = buildCreateAccountRequest(PROVIDERS, input);
    const without = buildCreateAccountRequest(PROVIDERS, baseInput);

    expect(withSite).toStrictEqual({ ...without, siteId: SITE_A_ID });
  });
});

/* -------------------------------------------------------------------------- */
/* #68 「サイト」ボタンと Modal                                                   */
/* -------------------------------------------------------------------------- */

function changeDialog(target: SiteAccountRow, overrides: Partial<SiteProps> = {}): string {
  const dialog = dialogOf(
    render({ initialSiteEditingAccountId: target.id, ...overrides }),
    CHANGE_TITLE,
  );
  expect(dialog, '「サイトの紐づけを変える」の Modal').toBeDefined();
  return dialog ?? '';
}

function changeSelect(target: SiteAccountRow): string {
  const select = /<select\b[^>]*>[\s\S]*?<\/select>/.exec(changeDialog(target))?.[0];
  expect(select, 'Modal の Select').toBeDefined();
  return select ?? '';
}

describe('#68 「サイト」ボタンの出し分け', () => {
  it('#68 social.write と canReadSites があれば各行に「サイト」ボタンがある', () => {
    const html = render();

    for (const target of [ACC_A, ACC_COMMON, ACC_ARCHIVED]) {
      expect(hasButton(rowOf(html, target.displayName), CHANGE_BUTTON), target.displayName).toBe(
        true,
      );
    }
  });

  it('#68 canReadSites が false なら「サイト」ボタンが無い', () => {
    const html = render({ sites: [], canReadSites: false });

    expect(hasButton(rowOf(html, ACC_A.displayName), CHANGE_BUTTON)).toBe(false);
    expect(hasButton(rowOf(html, ACC_COMMON.displayName), CHANGE_BUTTON)).toBe(false);
  });

  it('#68 social.write が無ければ「サイト」ボタンが無い', () => {
    const html = render({ permissions: ['social.read', 'social.delete'] });

    expect(hasButton(rowOf(html, ACC_A.displayName), CHANGE_BUTTON)).toBe(false);
  });

  it('#68 既定（initialSiteEditingAccountId なし）では Modal は閉じている', () => {
    expect(dialogOf(render(), CHANGE_TITLE)).toBeUndefined();
  });
});

describe('#68 「サイトの紐づけを変える」の Modal', () => {
  it('#68 サイト A の行で開くと、今の値（サイト A）が選ばれている', () => {
    expect(selectedValue(changeSelect(ACC_A))).toBe(SITE_A_ID);
  });

  it('#68 共通の行で開くと「共通」（値は空）が選ばれている', () => {
    expect(selectedValue(changeSelect(ACC_COMMON))).toBe('');
  });

  it('#68 選択肢は「共通」と active / paused のサイト', () => {
    const options = optionsOf(changeSelect(ACC_A));

    expect(options.map((option) => option.value)).toEqual(['', SITE_A_ID, SITE_B_ID]);
    expect(options[0]?.text).toBe(COMMON_OPTION);
  });

  it('#68 今の値がアーカイブしたサイトなら、そのサイトも選択肢にあり選ばれている', () => {
    const options = optionsOf(changeSelect(ACC_ARCHIVED));

    expect(options.map((option) => option.value)).toContain(SITE_C_ID);
    expect(selectedValue(changeSelect(ACC_ARCHIVED))).toBe(SITE_C_ID);
  });

  it('#68 今の値がアーカイブしたサイトでなければ、アーカイブしたサイトは選択肢に無い', () => {
    expect(optionsOf(changeSelect(ACC_COMMON)).map((option) => option.value)).not.toContain(
      SITE_C_ID,
    );
  });

  it('#68 注意の文言がある', () => {
    expect(textOf(changeDialog(ACC_A))).toContain(CHANGE_WARNING);
  });

  it('#68 「キャンセル」と「保存」がある', () => {
    const dialog = changeDialog(ACC_A);

    expect(hasButton(dialog, 'キャンセル')).toBe(true);
    expect(hasButton(dialog, '保存')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #69 サイトでの絞り込み                                                         */
/* -------------------------------------------------------------------------- */

/** 絞り込みの検査に使う行（サイトの名前を引けない行は混ぜない）。 */
const FILTER_ACCOUNTS: readonly SiteAccountRow[] = [
  ACC_A,
  ACC_A2,
  ACC_COMMON,
  ACC_OMITTED,
  ACC_ARCHIVED,
];

function filterSelect(overrides: Partial<SiteProps> = {}): string | undefined {
  return selectByLabel(render({ initialAccounts: FILTER_ACCOUNTS, ...overrides }), FILTER_LABEL);
}

/**
 * 絞り込みの選択肢の値。**値の形（「共通」を何で表すか）は設計が決めていない**ので、
 * 絞っていない描画の選択肢から文字で引き、その値を `initialSiteFilter` に渡す。
 */
function filterValueOf(text: string): string {
  const select = filterSelect();
  expect(select, '「サイトで絞り込む」').toBeDefined();
  const options = optionsOf(select ?? '');
  const option =
    options.find((candidate) => candidate.text === text) ??
    options.find((candidate) => candidate.text.includes(text));
  expect(option, `選択肢「${text}」`).toBeDefined();
  return option?.value ?? '';
}

function shownNames(html: string): string[] {
  return FILTER_ACCOUNTS.map((row) => row.displayName).filter(
    (name) => findRow(html, name) !== undefined,
  );
}

describe('#69 「サイトで絞り込む」', () => {
  it('#69 サイトに紐づいたアカウントがあれば「サイトで絞り込む」がある', () => {
    expect(filterSelect()).toBeDefined();
  });

  it('#69 選択肢は「すべて」（既定で選ばれている）・「共通」・アカウントが紐づいているサイト', () => {
    const options = optionsOf(filterSelect() ?? '');

    expect(options[0]?.text).toBe(FILTER_ALL);
    expect(selectedValue(filterSelect() ?? '')).toBe(options[0]?.value);
    expect(options.map((option) => option.text)).toContain(COMMON_LABEL);
    expect(options.some((option) => option.text.includes(SITE_A.name))).toBe(true);
    expect(options.some((option) => option.text.includes(SITE_C.name))).toBe(true);
  });

  it('#69 アカウントが紐づいていないサイトは選択肢に無い', () => {
    const select = filterSelect();
    expect(select, '「サイトで絞り込む」').toBeDefined();
    const options = optionsOf(select ?? '');

    expect(options.some((option) => option.text.includes(SITE_B.name))).toBe(false);
  });

  it('#69 既定（「すべて」）ではすべての行が出る', () => {
    const html = render({ initialAccounts: FILTER_ACCOUNTS });

    expect(shownNames(html)).toEqual(FILTER_ACCOUNTS.map((row) => row.displayName));
  });

  it('#69 「A」を選んだ状態ではサイト A の行だけが出る', () => {
    const value = filterValueOf(SITE_A.name);
    const html = render({ initialAccounts: FILTER_ACCOUNTS, initialSiteFilter: value });

    expect(shownNames(html)).toEqual([ACC_A.displayName, ACC_A2.displayName]);
  });

  it('#69 「A」を選んだ状態では絞り込みの Select で「A」が選ばれている', () => {
    const value = filterValueOf(SITE_A.name);
    expect(selectedValue(filterSelect({ initialSiteFilter: value }) ?? '')).toBe(value);
  });

  it('#69 「共通」を選んだ状態では siteId が null（と省略）の行だけが出る', () => {
    const value = filterValueOf(COMMON_LABEL);
    const html = render({ initialAccounts: FILTER_ACCOUNTS, initialSiteFilter: value });

    expect(shownNames(html)).toEqual([ACC_COMMON.displayName, ACC_OMITTED.displayName]);
  });

  it('#69 サイトに紐づいたアカウントが 0 件なら絞り込みを描かない', () => {
    const html = render({ initialAccounts: [ACC_COMMON, ACC_OMITTED] });

    expect(selectByLabel(html, FILTER_LABEL)).toBeUndefined();
    expect(textOf(html)).not.toContain(FILTER_LABEL);
  });

  it('#69 アカウントが 0 件なら絞り込みを描かない', () => {
    const html = render({ initialAccounts: [] });

    expect(textOf(html)).not.toContain(FILTER_LABEL);
  });
});
