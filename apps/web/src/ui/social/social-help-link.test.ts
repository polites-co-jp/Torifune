import type { PublisherRegistration } from '@torifune/plugin-api';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { KNOWN_PROVIDERS } from '@/domain/social/social';
import { buildProviderOptions } from './provider-options';
import {
  SocialAccounts,
  type AccountRow,
  type ProviderOption,
  type SocialAccountsProps,
} from './social-accounts';

/**
 * `/social` のヘルプボタン（041-plugin-help-docs 設計 §7.4、受け入れ条件 #40〜#45）。
 *
 * * `buildProviderOptions(publishers, helpOf)` は、`pluginId` を持ち `helpOf(pluginId)` が値を返す
 *   publisher の選択肢にだけ `help: { href, title }` を付ける（#40）。第 2 引数を省けば `help` を持たない（#41）
 * * アカウント追加の Modal と「資格情報を設定」の Modal に、入力の形が `fields` / `none` で
 *   `help` があるときだけヘルプボタンを出す。`free` には出さない（#42〜#44）
 * * ヘルプボタンは新しいタブで開く `<a target="_blank" rel="noopener noreferrer">` と、
 *   注記「新しいタブで開きます。入力中の内容はこの画面に残ります。」（設計 §7.4.2）
 *
 * **`useRouter` は App Router の外では例外を投げる**ので差し替える（`social-accounts-credentials.test.ts` と同じ）。
 * Modal は `initialCreating` / `initialEditingAccountId` で開いた状態で描く（押して開く経路は E2E #61 / #62）。
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

/* -------------------------------------------------------------------------- */
/* #40 / #41 選択肢の組み立て                                                    */
/* -------------------------------------------------------------------------- */

interface PublisherEntry {
  readonly pluginId?: string;
  readonly registration: PublisherRegistration;
}

const WITH_HELP_PLUGIN = 'help-plugin';
const WITHOUT_HELP_PLUGIN = 'plain-plugin';

/** 登録簿に publisher があり、その Plugin が手順書を宣言している provider。 */
const HELPFUL: PublisherEntry = {
  pluginId: WITH_HELP_PLUGIN,
  registration: {
    provider: 'helpful',
    label: '手順書つきSNS',
    credentialFields: [{ key: 'token', label: 'トークン', kind: 'secret' }],
  },
};

/** 登録簿に publisher があるが、その Plugin が手順書を宣言していない provider。 */
const PLAIN: PublisherEntry = {
  pluginId: WITHOUT_HELP_PLUGIN,
  registration: {
    provider: 'plain',
    label: '手順書なしSNS',
    credentialFields: [{ key: 'token', label: 'トークン', kind: 'secret' }],
  },
};

/** `pluginId` を持たない publisher の情報（039 の呼び出しの形）。 */
const NO_PLUGIN_ID: PublisherEntry = {
  registration: { provider: 'anonymous', label: '出所不明SNS', credentialFields: [] },
};

const HELP_HREF = `/plugins/${WITH_HELP_PLUGIN}/help/credentials`;
const HELP_TITLE = 'トークンの発行手順';

/** `helpLinkOfPlugin` と同じ形（`id` / `title` / `href`）を返す偽物。 */
function helpOf(pluginId: string): { id: string; title: string; href: string } | null {
  if (pluginId === WITH_HELP_PLUGIN)
    return { id: 'credentials', title: HELP_TITLE, href: HELP_HREF };
  // `pluginId` を持たない publisher や、手順書の無い Plugin の ID で呼ばれても何も返さない
  return null;
}

function optionOf(options: readonly ProviderOption[], value: string): ProviderOption {
  const found = options.find((option) => option.value === value);
  if (found === undefined) throw new Error(`選択肢が無い: ${value}`);
  return found;
}

/** `help` を除いた選択肢（他の項目が変わっていないことを見る）。 */
function withoutHelp(option: ProviderOption): Record<string, unknown> {
  const { help: _help, ...rest } = option as ProviderOption & { help?: unknown };
  return rest;
}

describe('#40 helpOf を渡すと、手順書のある Plugin の publisher の選択肢だけが help を持つ', () => {
  const options = (): ProviderOption[] =>
    buildProviderOptions([HELPFUL, PLAIN, NO_PLUGIN_ID], helpOf);

  it('#40 pluginId を持ち helpOf が値を返す publisher の選択肢は help を持つ', () => {
    expect(optionOf(options(), 'helpful').help).toBeDefined();
  });

  it('#40 help は href と title ちょうど（helpOf の id は持ち込まない）', () => {
    expect(optionOf(options(), 'helpful').help).toStrictEqual({
      href: HELP_HREF,
      title: HELP_TITLE,
    });
  });

  it('#40 helpOf が null を返す publisher の選択肢は help のキーを持たない', () => {
    expect('help' in optionOf(options(), 'plain')).toBe(false);
  });

  it('#40 pluginId を持たない publisher の選択肢は help のキーを持たない', () => {
    expect('help' in optionOf(options(), 'anonymous')).toBe(false);
  });

  it('#40 pluginId を持たない publisher では、helpOf が何を返しても help を持たない', () => {
    const always = (): { id: string; title: string; href: string } => ({
      id: 'credentials',
      title: HELP_TITLE,
      href: HELP_HREF,
    });

    expect('help' in optionOf(buildProviderOptions([NO_PLUGIN_ID], always), 'anonymous')).toBe(
      false,
    );
  });

  it('#40 KNOWN_PROVIDERS にだけある provider の選択肢は help を持たない', () => {
    const registered = new Set(['helpful', 'plain', 'anonymous']);
    const knownOnly = KNOWN_PROVIDERS.filter((provider) => !registered.has(provider));
    expect(knownOnly.length).toBeGreaterThan(0);

    for (const provider of knownOnly) {
      expect('help' in optionOf(options(), provider), provider).toBe(false);
    }
  });

  it('#40 KNOWN_PROVIDERS にだけある provider では、helpOf がどの ID に値を返しても help を持たない', () => {
    const always = (): { id: string; title: string; href: string } => ({
      id: 'credentials',
      title: HELP_TITLE,
      href: HELP_HREF,
    });

    for (const option of buildProviderOptions([], always)) {
      expect('help' in option, option.value).toBe(false);
    }
  });

  it('#40 help 以外の項目は第 2 引数を省いたときと深く等しい', () => {
    const withHelp = options().map(withoutHelp);
    const without = buildProviderOptions([HELPFUL, PLAIN, NO_PLUGIN_ID]);

    expect(withHelp).toStrictEqual(without);
  });
});

describe('#41 第 2 引数を省くと、どの選択肢も help を持たない', () => {
  it('#41 pluginId を持つ publisher を渡しても help のキーが無い', () => {
    for (const option of buildProviderOptions([HELPFUL, PLAIN, NO_PLUGIN_ID])) {
      expect('help' in option, option.value).toBe(false);
    }
  });

  it('#41 publisher が無くても help のキーが無い', () => {
    for (const option of buildProviderOptions([])) {
      expect('help' in option, option.value).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #42〜#45 Modal のヘルプボタン                                                 */
/* -------------------------------------------------------------------------- */

const EXAMPLE_HELP = {
  href: '/plugins/example-plugin/help/usage',
  title: 'サンプルSNS の資格情報の用意のしかた',
} as const;

const NONE_HELP = {
  href: '/plugins/none-plugin/help/usage',
  title: '手動投稿の使い方',
} as const;

const FREE_HELP = {
  href: '/plugins/free-plugin/help/usage',
  title: '使われないはずの手順書',
} as const;

const HANDLE_LABEL = 'サンプルSNSのハンドル';

/** publisher あり・項目あり（`fields`）・手順書あり。 */
const EXAMPLE_WITH_HELP = {
  value: 'example',
  label: 'サンプルSNS',
  credentialFields: [
    { key: 'handle', label: HANDLE_LABEL, kind: 'text' },
    { key: 'appPassword', label: 'アプリパスワード', kind: 'secret' },
  ],
  publisherRegistered: true,
  help: EXAMPLE_HELP,
} as ProviderOption;

/** publisher あり・項目あり（`fields`）・手順書なし。 */
const FIELDS_WITHOUT_HELP = {
  value: 'fieldsonly',
  label: '手順書なしSNS',
  credentialFields: [{ key: 'token', label: 'トークン', kind: 'secret' }],
  publisherRegistered: true,
} as ProviderOption;

/** publisher あり・`[]`（`none`）・手順書あり。 */
const NONE_WITH_HELP = {
  value: 'x',
  label: 'X',
  credentialFields: [],
  publisherRegistered: true,
  help: NONE_HELP,
} as ProviderOption;

/** publisher なし（`free`）。`help` を持たせても出してはならない。 */
const FREE_WITH_HELP = {
  value: 'bluesky',
  label: 'Bluesky',
  credentialFields: [],
  publisherRegistered: false,
  help: FREE_HELP,
} as ProviderOption;

const ALL_PROVIDERS: readonly ProviderOption[] = [
  EXAMPLE_WITH_HELP,
  FIELDS_WITHOUT_HELP,
  NONE_WITH_HELP,
  FREE_WITH_HELP,
];

function account(provider: string, suffix: string): AccountRow {
  return {
    id: `01900000-0000-7000-8000-000000041${suffix}`,
    provider,
    displayName: `${provider} の公式`,
    handle: `@${provider}_official`,
    status: 'disconnected',
    credentialConfigured: false,
  };
}

const EXAMPLE_ACCOUNT = account('example', 'a01');
const FIELDS_ACCOUNT = account('fieldsonly', 'a02');
const NONE_ACCOUNT = account('x', 'a03');
const FREE_ACCOUNT = account('bluesky', 'a04');

const BASE: SocialAccountsProps = {
  initialAccounts: [EXAMPLE_ACCOUNT, FIELDS_ACCOUNT, NONE_ACCOUNT, FREE_ACCOUNT],
  permissions: ['social.read', 'social.write', 'social.delete'],
  providers: ALL_PROVIDERS,
};

const ADD_TITLE = 'SNSアカウントを追加';
const EDIT_TITLE = '資格情報を設定';
const NEW_TAB_NOTE = '新しいタブで開きます。入力中の内容はこの画面に残ります。';
const HELP_PREFIX = '手順書：';
const FIELDS_NOTE =
  '保存済みの値は表示しません。保存すると、保存済みの資格情報はすべてここで入力した値に置き換わります（一部の項目だけを変えることはできません）。';

function render(overrides: Partial<SocialAccountsProps> = {}): string {
  return renderToStaticMarkup(createElement(SocialAccounts, { ...BASE, ...overrides }));
}

/** アカウント追加の Modal を、`first` を先頭の選択肢にして開いた状態で描く。 */
function renderCreating(first: ProviderOption): string {
  const providers = [first, ...ALL_PROVIDERS.filter((option) => option !== first)];
  return dialogFrom(render({ initialCreating: true, providers }), ADD_TITLE);
}

/** 「資格情報を設定」の Modal を、`row` のアカウントで開いた状態で描く。 */
function renderEditing(row: AccountRow): string {
  return dialogFrom(
    render({ initialAccounts: [row], initialEditingAccountId: row.id }),
    EDIT_TITLE,
  );
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

/** `aria-label` が `title` の `role="dialog"` から後ろの HTML（`social-accounts-credentials.test.ts` と同じ）。 */
function dialogFrom(html: string, title: string): string {
  const tags = [...html.matchAll(/<div[^>]*role="dialog"[^>]*>/g)];
  const found = tags.find((match) => match[0].includes(`aria-label="${title}"`));
  if (found === undefined) throw new Error(`ダイアログ「${title}」が無い`);
  return html.slice(found.index);
}

function attributeOf(tag: string, name: string): string | null {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

interface Anchor {
  readonly index: number;
  readonly tag: string;
  readonly text: string;
}

/** HTML の中の `<a …>…</a>`（属性の順を仮定しない）。 */
function anchors(html: string): Anchor[] {
  return [...html.matchAll(/<a(\s[^>]*)?>([\s\S]*?)<\/a>/g)].map((match) => ({
    index: match.index,
    tag: match[0].slice(0, match[0].indexOf('>') + 1),
    text: textOf(match[2] ?? ''),
  }));
}

/** `href` が `href` の `<a>`。 */
function anchorsTo(html: string, href: string): Anchor[] {
  return anchors(html).filter((anchor) => attributeOf(anchor.tag, 'href') === href);
}

/** 新しいタブで開くリンク（ヘルプボタンの形）。 */
function newTabAnchors(html: string): Anchor[] {
  return anchors(html).filter((anchor) => attributeOf(anchor.tag, 'target') === '_blank');
}

/** 1 つのヘルプボタンが設計 §7.4.2 の形で描かれていること。 */
function expectHelpButton(html: string, help: { href: string; title: string }): void {
  const found = anchorsTo(html, help.href);
  expect(found, `href="${help.href}" の <a> が 1 つではない`).toHaveLength(1);

  const [anchor] = found;
  expect(attributeOf(anchor?.tag ?? '', 'target')).toBe('_blank');
  expect(attributeOf(anchor?.tag ?? '', 'rel')).toBe('noopener noreferrer');
  expect(anchor?.text ?? '').toContain(help.title);
  expect(textOf(html)).toContain(NEW_TAB_NOTE);
}

describe('#42 アカウント追加の Modal：fields で help があればヘルプボタンが出る', () => {
  it('#42 href がその手順書の URL の <a> がちょうど 1 つある', () => {
    expect(anchorsTo(renderCreating(EXAMPLE_WITH_HELP), EXAMPLE_HELP.href)).toHaveLength(1);
  });

  it('#42 その <a> は target="_blank"', () => {
    const [anchor] = anchorsTo(renderCreating(EXAMPLE_WITH_HELP), EXAMPLE_HELP.href);

    expect(attributeOf(anchor?.tag ?? '', 'target')).toBe('_blank');
  });

  it('#42 その <a> は rel="noopener noreferrer"', () => {
    const [anchor] = anchorsTo(renderCreating(EXAMPLE_WITH_HELP), EXAMPLE_HELP.href);

    expect(attributeOf(anchor?.tag ?? '', 'rel')).toBe('noopener noreferrer');
  });

  it('#42 その <a> の文言に手順書の題名がある', () => {
    const [anchor] = anchorsTo(renderCreating(EXAMPLE_WITH_HELP), EXAMPLE_HELP.href);

    expect(anchor?.text ?? '').toContain(EXAMPLE_HELP.title);
  });

  it('#42 その <a> の文言は「手順書：」から始まる題名を含む（設計 §7.4.2 / §7.7）', () => {
    const [anchor] = anchorsTo(renderCreating(EXAMPLE_WITH_HELP), EXAMPLE_HELP.href);

    expect(anchor?.text ?? '').toContain(`${HELP_PREFIX}${EXAMPLE_HELP.title}`);
  });

  it('#42 注記「新しいタブで開きます。入力中の内容はこの画面に残ります。」がある', () => {
    expect(textOf(renderCreating(EXAMPLE_WITH_HELP))).toContain(NEW_TAB_NOTE);
  });

  it('#42 新しいタブで開くリンクは、そのヘルプボタンの 1 つだけ', () => {
    expect(newTabAnchors(renderCreating(EXAMPLE_WITH_HELP))).toHaveLength(1);
  });

  it('#42 ヘルプボタンは「サービス」の選択の後、資格情報の欄より前にある（設計 §7.4.2）', () => {
    const html = renderCreating(EXAMPLE_WITH_HELP);
    const serviceAt = html.indexOf('サービス');
    const helpAt = anchorsTo(html, EXAMPLE_HELP.href)[0]?.index ?? -1;
    const fieldAt = html.indexOf(HANDLE_LABEL);

    expect(serviceAt).toBeGreaterThanOrEqual(0);
    expect(helpAt).toBeGreaterThan(serviceAt);
    expect(fieldAt).toBeGreaterThan(helpAt);
  });
});

describe('#43 アカウント追加の Modal：入力の形と help の有無で出し分ける', () => {
  it('#43 none で help があれば、ヘルプボタンが設計の形で出る', () => {
    expectHelpButton(renderCreating(NONE_WITH_HELP), NONE_HELP);
  });

  it('#43 free では help を持たせてもヘルプボタンが出ない', () => {
    const html = renderCreating(FREE_WITH_HELP);

    expect(anchorsTo(html, FREE_HELP.href)).toHaveLength(0);
    expect(newTabAnchors(html)).toHaveLength(0);
  });

  it('#43 free では注記も出ない', () => {
    expect(textOf(renderCreating(FREE_WITH_HELP))).not.toContain(NEW_TAB_NOTE);
  });

  it('#43 fields で help が無ければヘルプボタンが出ない', () => {
    const html = renderCreating(FIELDS_WITHOUT_HELP);

    expect(newTabAnchors(html)).toHaveLength(0);
    expect(textOf(html)).not.toContain(NEW_TAB_NOTE);
  });

  it('#43 先頭の選択肢の help だけが出る（他の選択肢の help は出ない）', () => {
    const html = renderCreating(EXAMPLE_WITH_HELP);

    expect(anchorsTo(html, NONE_HELP.href)).toHaveLength(0);
    expect(anchorsTo(html, FREE_HELP.href)).toHaveLength(0);
  });
});

describe('#44 「資格情報を設定」の Modal：#42・#43 と同じことが成り立つ', () => {
  it('#44 fields で help があれば、ヘルプボタンが設計の形で出る', () => {
    expectHelpButton(renderEditing(EXAMPLE_ACCOUNT), EXAMPLE_HELP);
  });

  it('#44 fields のヘルプボタンの文言は「手順書：」＋題名を含む', () => {
    const [anchor] = anchorsTo(renderEditing(EXAMPLE_ACCOUNT), EXAMPLE_HELP.href);

    expect(anchor?.text ?? '').toContain(`${HELP_PREFIX}${EXAMPLE_HELP.title}`);
  });

  it('#44 新しいタブで開くリンクは、そのヘルプボタンの 1 つだけ', () => {
    expect(newTabAnchors(renderEditing(EXAMPLE_ACCOUNT))).toHaveLength(1);
  });

  it('#44 none で help があれば、ヘルプボタンが設計の形で出る', () => {
    expectHelpButton(renderEditing(NONE_ACCOUNT), NONE_HELP);
  });

  it('#44 free では help を持たせてもヘルプボタンも注記も出ない', () => {
    const html = renderEditing(FREE_ACCOUNT);

    expect(anchorsTo(html, FREE_HELP.href)).toHaveLength(0);
    expect(newTabAnchors(html)).toHaveLength(0);
    expect(textOf(html)).not.toContain(NEW_TAB_NOTE);
  });

  it('#44 fields で help が無ければヘルプボタンが出ない', () => {
    const html = renderEditing(FIELDS_ACCOUNT);

    expect(newTabAnchors(html)).toHaveLength(0);
    expect(textOf(html)).not.toContain(NEW_TAB_NOTE);
  });

  it('#44 ヘルプボタンは「現在の状態」の行の後、説明の Alert より前にある（設計 §7.4.2）', () => {
    const html = renderEditing(EXAMPLE_ACCOUNT);
    const stateAt = html.indexOf('現在の状態');
    const helpAt = anchorsTo(html, EXAMPLE_HELP.href)[0]?.index ?? -1;
    const noteAt = html.indexOf(FIELDS_NOTE);

    expect(stateAt).toBeGreaterThanOrEqual(0);
    expect(helpAt).toBeGreaterThan(stateAt);
    expect(noteAt).toBeGreaterThan(helpAt);
  });
});

describe('#45 Modal を開いていなければヘルプボタンが描かれない', () => {
  it('#45 手順書の URL への <a> が 1 つも無い', () => {
    const html = render();

    for (const help of [EXAMPLE_HELP, NONE_HELP, FREE_HELP]) {
      expect(anchorsTo(html, help.href), help.href).toHaveLength(0);
    }
  });

  it('#45 注記「新しいタブで開きます。…」が無い', () => {
    expect(textOf(render())).not.toContain(NEW_TAB_NOTE);
  });

  it('#45 「手順書：」の文言が無い', () => {
    expect(textOf(render())).not.toContain(HELP_PREFIX);
  });
});
