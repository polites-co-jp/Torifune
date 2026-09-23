import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  SocialAccounts,
  type AccountRow,
  type ProviderOption,
  type SocialAccountsProps,
} from './social-accounts';

/**
 * 資格情報の欄の出し分けと、入れ直しの Modal の描画（039-social-credential-fields 設計 §7.1〜§7.3、
 * 受け入れ条件 #16〜#24、#49〜#52）。
 *
 * **`useRouter` は App Router の外では例外を投げる**ので差し替える（保存・消去の後に
 * `router.refresh()` を呼ぶ。設計 §7.3.4）。`ui/analytics/settings-tab.test.ts` と同じ形。
 *
 * 単体テストの環境には DOM が無く、ボタンを押して Modal を開けない。入れ直しの Modal は
 * `initialEditingAccountId`（`initialCreating` と同じ理由でテストのためにある口）で開いた状態で描く。
 * 保存・消去・閉じたら入力値を捨てることは E2E（#35〜#39）が見る。
 *
 * `aria-describedby` の検査は `useId` の値を決め打ちしない。HTML の文字列から
 * 「説明の文字列を持つ要素の `id`」を取り出し、その欄の入力の `aria-describedby`
 * （空白区切り）にその `id` が含まれることを見る（実装プラン §2）。
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

/* -------------------------------------------------------------------------- */
/* データ                                                                       */
/* -------------------------------------------------------------------------- */

const HANDLE_LABEL = 'サンプルSNSのハンドル';
const HANDLE_DESCRIPTION = 'サンプルSNS 側の利用者名。';
const APP_PASSWORD_LABEL = 'アプリパスワード';
const APP_PASSWORD_DESCRIPTION = 'アプリの設定画面で発行した値。';

/** publisher あり・項目あり（`fields`）。 */
const EXAMPLE: ProviderOption = {
  value: 'example',
  label: 'サンプルSNS',
  credentialFields: [
    { key: 'handle', label: HANDLE_LABEL, kind: 'text', description: HANDLE_DESCRIPTION },
    {
      key: 'appPassword',
      label: APP_PASSWORD_LABEL,
      kind: 'secret',
      description: APP_PASSWORD_DESCRIPTION,
    },
  ],
  publisherRegistered: true,
};

/** publisher あり・`[]`（`none`）。 */
const X_NONE: ProviderOption = {
  value: 'x',
  label: 'X',
  credentialFields: [],
  publisherRegistered: true,
};

/** publisher なし（`free`）。 */
const BLUESKY_FREE: ProviderOption = {
  value: 'bluesky',
  label: 'Bluesky',
  credentialFields: [],
  publisherRegistered: false,
};

const PROVIDERS: readonly ProviderOption[] = [EXAMPLE, X_NONE, BLUESKY_FREE];

const EXAMPLE_ACCOUNT: AccountRow = {
  id: '01900000-0000-7000-8000-0000000039a1',
  provider: 'example',
  displayName: 'サンプル公式',
  handle: '@sample',
  status: 'disconnected',
  credentialConfigured: false,
};

const X_ACCOUNT: AccountRow = {
  id: '01900000-0000-7000-8000-0000000039a2',
  provider: 'x',
  displayName: 'X 公式',
  handle: '@x_official',
  status: 'connected',
  credentialConfigured: false,
};

const BLUESKY_ACCOUNT: AccountRow = {
  id: '01900000-0000-7000-8000-0000000039a3',
  provider: 'bluesky',
  displayName: 'Bluesky 公式',
  handle: '@bsky_official',
  status: 'disconnected',
  credentialConfigured: false,
};

const ACCOUNTS: readonly AccountRow[] = [EXAMPLE_ACCOUNT, X_ACCOUNT, BLUESKY_ACCOUNT];

const BASE: SocialAccountsProps = {
  initialAccounts: ACCOUNTS,
  permissions: ['social.read', 'social.write', 'social.delete'],
  providers: PROVIDERS,
};

/* 設計 §7.2 / §7.3.2 の文言 */
const SET_CREDENTIAL = '資格情報を設定';
const CLEAR_CREDENTIAL = '資格情報を消す';
const STATE_CONFIGURED = '現在の状態：設定済み';
const STATE_NOT_CONFIGURED = '現在の状態：未設定';
const GENERIC_FIELD_LABEL = '資格情報（アクセストークン等）';
const NONE_NOTE = 'この SNS の配信 Plugin は資格情報を使いません。入力は要りません。';
const FIELDS_NOTE =
  '保存済みの値は表示しません。保存すると、保存済みの資格情報はすべてここで入力した値に置き換わります（一部の項目だけを変えることはできません）。';
const FREE_NOTE =
  'この SNS の配信 Plugin が有効になっていないため、入力した値を形式を確かめずにそのまま保存します。配信 Plugin を有効にした後は、その Plugin の項目で入れ直してください。';
const NONE_WARNING_1 = '保存済みの資格情報がありますが、いまの配信 Plugin では使われません。';
const NONE_WARNING_2 =
  '同じ SNS の別の配信 Plugin に入れ替えるとその Plugin が読み、形式が合わなければ自動配信が失敗します。不要なら消してください。';

/* -------------------------------------------------------------------------- */
/* 描画と HTML の読み方                                                           */
/* -------------------------------------------------------------------------- */

function render(overrides: Partial<SocialAccountsProps> = {}): string {
  return renderToStaticMarkup(createElement(SocialAccounts, { ...BASE, ...overrides }));
}

/** 入れ直しの Modal を開いた状態で描く。 */
function renderEditing(account: AccountRow, overrides: Partial<SocialAccountsProps> = {}): string {
  return render({ initialAccounts: [account], initialEditingAccountId: account.id, ...overrides });
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

function passwordInputs(html: string): string[] {
  return [...html.matchAll(/<input[^>]*type="password"[^>]*>/g)].map((match) => match[0]);
}

/** `type="hidden"` 以外の入力。 */
function visibleInputs(html: string): string[] {
  return [...html.matchAll(/<input[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => !tag.includes('type="hidden"'));
}

/** 文字列がちょうど `name` のボタン。 */
function buttons(html: string, name: string): string[] {
  const pattern = new RegExp(`<button[^>]*>${escapeRegExp(name)}</button>`, 'g');
  return [...html.matchAll(pattern)].map((match) => match[0]);
}

/**
 * `aria-label` が `title` の `role="dialog"` から後ろの HTML。
 *
 * Modal は開いているものしか描かれず、後ろには閉じたダイアログ（描かれない）と Toast しか無い。
 * 一覧の行にある「資格情報を設定」のボタンを数えないために、ダイアログの開始から切り出す。
 */
function dialogFrom(html: string, title: string): string {
  const tags = [...html.matchAll(/<div[^>]*role="dialog"[^>]*>/g)];
  const found = tags.find((match) => match[0].includes(`aria-label="${title}"`));
  if (found === undefined) throw new Error(`ダイアログ「${title}」が無い`);
  return html.slice(found.index);
}

function hasDialog(html: string, title: string): boolean {
  return [...html.matchAll(/<div[^>]*role="dialog"[^>]*>/g)].some((match) =>
    match[0].includes(`aria-label="${title}"`),
  );
}

function attributeOf(tag: string, name: string): string | null {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

/** 中身の文字列がちょうど `text` の要素（開始タグの位置と `id`）。 */
function elementWithText(html: string, text: string): { index: number; id: string | null } | null {
  const pattern = new RegExp(`<(\\w+)(\\s[^>]*)?>${escapeRegExp(text)}</\\1>`);
  const match = pattern.exec(html);
  if (match === null) return null;
  return {
    index: match.index,
    id: attributeOf(match[0].slice(0, match[0].indexOf('>') + 1), 'id'),
  };
}

/** ラベルの文字列の後に最初に現れる入力（その欄の入力）。 */
function inputAfter(html: string, label: string): string {
  const at = html.indexOf(label);
  if (at < 0) throw new Error(`ラベル「${label}」が無い`);
  const input = /<input[^>]*>/.exec(html.slice(at))?.[0];
  if (input === undefined) throw new Error(`ラベル「${label}」の後に入力が無い`);
  return input;
}

/**
 * ラベルの後に説明が描かれ、その欄の入力の `aria-describedby` が説明の要素を指すこと
 * （#49 / #50）。
 */
function expectDescribed(html: string, label: string, description: string): void {
  const labelAt = html.indexOf(label);
  const element = elementWithText(html, description);

  expect(labelAt, `ラベル「${label}」が無い`).toBeGreaterThanOrEqual(0);
  expect(element, `説明「${description}」の要素が無い`).not.toBeNull();
  expect(element?.index ?? -1, '説明がラベルの後に無い').toBeGreaterThan(labelAt);
  expect(element?.id ?? null, '説明の要素に id が無い').not.toBeNull();

  const describedBy = attributeOf(inputAfter(html, label), 'aria-describedby') ?? '';
  expect(describedBy.split(/\s+/), `「${label}」の入力が説明を指していない`).toContain(element?.id);
}

/* -------------------------------------------------------------------------- */
/* §10.4 行の「資格情報を設定」                                                     */
/* -------------------------------------------------------------------------- */

describe('#16 行の「資格情報を設定」は social.write のときだけ出る', () => {
  it('#16 social.write と social.delete を持つとき、各行に「資格情報を設定」がある', () => {
    const html = render();

    expect(buttons(html, SET_CREDENTIAL)).toHaveLength(ACCOUNTS.length);
  });

  it('#16 social.write を持ち social.delete を持たないときも、各行に「資格情報を設定」がある', () => {
    const html = render({ permissions: ['social.read', 'social.write'] });

    expect(buttons(html, SET_CREDENTIAL)).toHaveLength(ACCOUNTS.length);
    expect(buttons(html, '削除')).toHaveLength(0);
  });

  it('#16 social.read だけなら「資格情報を設定」が無い', () => {
    const html = render({ permissions: ['social.read'] });

    expect(buttons(html, SET_CREDENTIAL)).toHaveLength(0);
  });

  it('#16 social.read と social.delete を持っても social.write が無ければ「資格情報を設定」が無い', () => {
    const html = render({ permissions: ['social.read', 'social.delete'] });

    expect(buttons(html, SET_CREDENTIAL)).toHaveLength(0);
    expect(buttons(html, '削除')).toHaveLength(ACCOUNTS.length);
  });

  it('#16 行の中では「資格情報を設定」「削除」の順に並ぶ', () => {
    const html = render({ initialAccounts: [EXAMPLE_ACCOUNT] });
    const setAt = html.indexOf(buttons(html, SET_CREDENTIAL)[0] ?? '<none>');
    const deleteAt = html.indexOf(buttons(html, '削除')[0] ?? '<none>');

    expect(setAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(setAt);
  });
});

describe('#17 入れ直しの Modal を開いていなければ描かれない', () => {
  it('#17 「資格情報を設定」のダイアログが無い', () => {
    expect(hasDialog(render(), SET_CREDENTIAL)).toBe(false);
  });

  it('#17 「現在の状態」が描かれない', () => {
    expect(textOf(render())).not.toContain('現在の状態');
  });

  it('#17 入れ直しの欄が描かれない', () => {
    const html = render();

    expect(passwordInputs(html)).toHaveLength(0);
    expect(textOf(html)).not.toContain(HANDLE_LABEL);
    expect(textOf(html)).not.toContain(GENERIC_FIELD_LABEL);
  });
});

/* -------------------------------------------------------------------------- */
/* §10.4 アカウント追加（none）                                                    */
/* -------------------------------------------------------------------------- */

describe('#18 アカウント追加・none', () => {
  const renderCreatingNone = (): string =>
    dialogFrom(
      render({ initialCreating: true, providers: [X_NONE, EXAMPLE, BLUESKY_FREE] }),
      'SNSアカウントを追加',
    );

  it('#18 「資格情報（アクセストークン等）」が無い', () => {
    expect(textOf(renderCreatingNone())).not.toContain(GENERIC_FIELD_LABEL);
  });

  it('#18 type="password" の入力が 0 個', () => {
    expect(passwordInputs(renderCreatingNone())).toHaveLength(0);
  });

  it('#18 説明「この SNS の配信 Plugin は資格情報を使いません。入力は要りません。」がある', () => {
    expect(textOf(renderCreatingNone())).toContain(NONE_NOTE);
  });

  it('#18 fields の provider を先頭にすれば説明は出ない（none のときだけ）', () => {
    const dialog = dialogFrom(render({ initialCreating: true }), 'SNSアカウントを追加');

    expect(textOf(dialog)).not.toContain(NONE_NOTE);
  });

  it('#18 free の provider を先頭にすれば汎用の欄が出る（現行のまま）', () => {
    const dialog = dialogFrom(
      render({ initialCreating: true, providers: [BLUESKY_FREE, EXAMPLE, X_NONE] }),
      'SNSアカウントを追加',
    );

    expect(textOf(dialog)).toContain(GENERIC_FIELD_LABEL);
    expect(passwordInputs(dialog)).toHaveLength(1);
    expect(textOf(dialog)).not.toContain(NONE_NOTE);
  });
});

/* -------------------------------------------------------------------------- */
/* §10.4 入れ直し（fields）                                                       */
/* -------------------------------------------------------------------------- */

describe('#19 入れ直し・fields', () => {
  const dialog = (): string => dialogFrom(renderEditing(EXAMPLE_ACCOUNT), SET_CREDENTIAL);

  it('#19 タイトルが「資格情報を設定」', () => {
    expect(dialog()).toMatch(/<h2[^>]*>資格情報を設定<\/h2>/);
  });

  it('#19 「対象：<表示名>（<サービスの表示名>）」がある', () => {
    expect(textOf(dialog())).toContain('対象：サンプル公式（サンプルSNS）');
  });

  it('#19 宣言の項目のラベルが宣言の順に並ぶ', () => {
    const text = textOf(dialog());
    const handle = text.indexOf(HANDLE_LABEL);
    const appPassword = text.indexOf(APP_PASSWORD_LABEL);

    expect(handle).toBeGreaterThanOrEqual(0);
    expect(appPassword).toBeGreaterThan(handle);
  });

  it('#19 宣言の順を入れ替えると並びも入れ替わる（宣言の順に従う）', () => {
    const reversed: ProviderOption = {
      ...EXAMPLE,
      credentialFields: [...EXAMPLE.credentialFields].reverse(),
    };
    const text = textOf(
      dialogFrom(renderEditing(EXAMPLE_ACCOUNT, { providers: [reversed, X_NONE] }), SET_CREDENTIAL),
    );

    expect(text.indexOf(APP_PASSWORD_LABEL)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(HANDLE_LABEL)).toBeGreaterThan(text.indexOf(APP_PASSWORD_LABEL));
  });

  it('#19 kind: \'secret\' の項目は type="password"', () => {
    expect(inputAfter(dialog(), APP_PASSWORD_LABEL)).toContain('type="password"');
  });

  it("#19 kind: 'text' の項目は伏せない", () => {
    expect(inputAfter(dialog(), HANDLE_LABEL)).not.toContain('type="password"');
  });

  it('#19 伏せる入力は secret の項目の 1 つだけ', () => {
    expect(passwordInputs(dialog())).toHaveLength(1);
  });

  it('#19 どの入力にも空でない value 属性が無い（保存済みの値を戻さない）', () => {
    const inputs = visibleInputs(dialog());

    expect(inputs.length).toBeGreaterThanOrEqual(2);
    for (const input of inputs) {
      expect(input).not.toMatch(/\svalue="[^"]/);
    }
  });

  it('#19 置き換えの説明文がある', () => {
    expect(textOf(dialog())).toContain(FIELDS_NOTE);
  });

  it('#19 「キャンセル」と「保存」がある', () => {
    const html = dialog();

    expect(buttons(html, 'キャンセル')).toHaveLength(1);
    expect(buttons(html, '保存')).toHaveLength(1);
  });

  it('#19 汎用の欄と none の説明は出ない', () => {
    const text = textOf(dialog());

    expect(text).not.toContain(GENERIC_FIELD_LABEL);
    expect(text).not.toContain(NONE_NOTE);
  });

  it('#19 表示名・ハンドルの欄を出さない（入力は宣言の 2 項目だけ）', () => {
    expect(visibleInputs(dialog())).toHaveLength(2);
  });
});

describe('#20 現在の状態と「資格情報を消す」', () => {
  it('#20 credentialConfigured: true なら「現在の状態：設定済み」', () => {
    const html = dialogFrom(
      renderEditing({ ...EXAMPLE_ACCOUNT, credentialConfigured: true }),
      SET_CREDENTIAL,
    );

    expect(textOf(html)).toContain(STATE_CONFIGURED);
    expect(textOf(html)).not.toContain(STATE_NOT_CONFIGURED);
  });

  it('#20 credentialConfigured: true なら「資格情報を消す」がある', () => {
    const html = dialogFrom(
      renderEditing({ ...EXAMPLE_ACCOUNT, credentialConfigured: true }),
      SET_CREDENTIAL,
    );

    expect(buttons(html, CLEAR_CREDENTIAL)).toHaveLength(1);
  });

  it('#20 credentialConfigured: false なら「現在の状態：未設定」', () => {
    const html = dialogFrom(renderEditing(EXAMPLE_ACCOUNT), SET_CREDENTIAL);

    expect(textOf(html)).toContain(STATE_NOT_CONFIGURED);
    expect(textOf(html)).not.toContain(STATE_CONFIGURED);
  });

  it('#20 credentialConfigured: false なら「資格情報を消す」が無い', () => {
    const html = dialogFrom(renderEditing(EXAMPLE_ACCOUNT), SET_CREDENTIAL);

    expect(textOf(html)).not.toContain(CLEAR_CREDENTIAL);
  });

  it('#20 free でも設定済みなら「資格情報を消す」がある', () => {
    const html = dialogFrom(
      renderEditing({ ...BLUESKY_ACCOUNT, credentialConfigured: true }),
      SET_CREDENTIAL,
    );

    expect(buttons(html, CLEAR_CREDENTIAL)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* §10.4 入れ直し（none）                                                         */
/* -------------------------------------------------------------------------- */

describe('#21 入れ直し・none', () => {
  const dialog = (configured: boolean): string =>
    dialogFrom(renderEditing({ ...X_ACCOUNT, credentialConfigured: configured }), SET_CREDENTIAL);

  it('#21 type="password" の入力が 0 個', () => {
    expect(passwordInputs(dialog(false))).toHaveLength(0);
    expect(passwordInputs(dialog(true))).toHaveLength(0);
  });

  it('#21 資格情報の項目の欄も汎用の欄も無い（入力が 0 個）', () => {
    expect(visibleInputs(dialog(false))).toHaveLength(0);
    expect(visibleInputs(dialog(true))).toHaveLength(0);
    expect(textOf(dialog(true))).not.toContain(GENERIC_FIELD_LABEL);
  });

  it('#21 「保存」が無く「閉じる」がある', () => {
    const html = dialog(true);

    expect(buttons(html, '保存')).toHaveLength(0);
    expect(buttons(html, '閉じる')).toHaveLength(1);
  });

  it('#21 説明「この SNS の配信 Plugin は資格情報を使いません。入力は要りません。」がある', () => {
    expect(textOf(dialog(false))).toContain(NONE_NOTE);
  });

  it('#21 設定済みなら警告文がある', () => {
    const text = textOf(dialog(true));

    expect(text).toContain(NONE_WARNING_1);
    expect(text).toContain(NONE_WARNING_2);
  });

  it('#21 設定済みなら「資格情報を消す」がある', () => {
    expect(buttons(dialog(true), CLEAR_CREDENTIAL)).toHaveLength(1);
  });

  it('#21 未設定なら警告文が無い', () => {
    const text = textOf(dialog(false));

    expect(text).not.toContain(NONE_WARNING_1);
    expect(text).not.toContain(NONE_WARNING_2);
  });

  it('#21 未設定なら「資格情報を消す」が無い', () => {
    expect(textOf(dialog(false))).not.toContain(CLEAR_CREDENTIAL);
  });
});

/* -------------------------------------------------------------------------- */
/* §10.4 入れ直し（free）                                                         */
/* -------------------------------------------------------------------------- */

describe('#22 入れ直し・free', () => {
  const dialog = (): string => dialogFrom(renderEditing(BLUESKY_ACCOUNT), SET_CREDENTIAL);

  it('#22 「資格情報（アクセストークン等）」の type="password" が 1 つ', () => {
    const html = dialog();

    expect(textOf(html)).toContain(GENERIC_FIELD_LABEL);
    expect(passwordInputs(html)).toHaveLength(1);
    expect(inputAfter(html, GENERIC_FIELD_LABEL)).toContain('type="password"');
  });

  it('#22 「形式を確かめずに」を含む説明文がある', () => {
    expect(textOf(dialog())).toContain(FREE_NOTE);
  });

  it('#22 汎用の欄にも空でない value 属性が無い', () => {
    for (const input of visibleInputs(dialog())) {
      expect(input).not.toMatch(/\svalue="[^"]/);
    }
  });

  it('#22 「キャンセル」と「保存」がある', () => {
    const html = dialog();

    expect(buttons(html, 'キャンセル')).toHaveLength(1);
    expect(buttons(html, '保存')).toHaveLength(1);
  });
});

describe('#23 providers に無い provider のアカウントは free として描く', () => {
  const dialog = (): string =>
    dialogFrom(
      renderEditing({ ...BLUESKY_ACCOUNT, provider: 'mastodon', displayName: 'マストドン' }),
      SET_CREDENTIAL,
    );

  it('#23 「資格情報（アクセストークン等）」の type="password" が 1 つ', () => {
    const html = dialog();

    expect(textOf(html)).toContain(GENERIC_FIELD_LABEL);
    expect(passwordInputs(html)).toHaveLength(1);
  });

  it('#23 「形式を確かめずに」を含む説明文がある', () => {
    expect(textOf(dialog())).toContain(FREE_NOTE);
  });
});

/* -------------------------------------------------------------------------- */
/* §10.4 AccountRow 以外の値を描かない                                             */
/* -------------------------------------------------------------------------- */

describe('#24 描いた HTML に AccountRow 以外から来た資格情報の値が現れない', () => {
  /**
   * `AccountRow` のキーちょうど。**キーが増えても減っても `pnpm typecheck` が落ちる**
   * （`Record<keyof AccountRow, true>` は足りないキーも余分なキーも許さない）。
   */
  const exactKeys: Record<keyof AccountRow, true> = {
    id: true,
    provider: true,
    displayName: true,
    handle: true,
    status: true,
    credentialConfigured: true,
  };

  const LEAK = 'leak-credential-value-3f9a';

  /** 型の外から平文を混ぜた行（応答をそのまま行にしたような形）。 */
  const leakyAccount = {
    ...EXAMPLE_ACCOUNT,
    credentialConfigured: true,
    credential: LEAK,
    credentials: { handle: LEAK, appPassword: LEAK },
  } as AccountRow;

  it('#24 AccountRow のキーは id / provider / displayName / handle / status / credentialConfigured', () => {
    expect(Object.keys(exactKeys).sort()).toEqual(
      ['credentialConfigured', 'displayName', 'handle', 'id', 'provider', 'status'].sort(),
    );
  });

  it('#24 一覧に混ぜた値が現れない', () => {
    expect(render({ initialAccounts: [leakyAccount] })).not.toContain(LEAK);
  });

  it('#24 入れ直しの Modal を開いても混ぜた値が現れない', () => {
    expect(renderEditing(leakyAccount)).not.toContain(LEAK);
  });
});

/* -------------------------------------------------------------------------- */
/* §10.9 項目の説明（description）                                                */
/* -------------------------------------------------------------------------- */

describe('#49 アカウント追加・fields の項目の説明', () => {
  const dialog = (): string => dialogFrom(render({ initialCreating: true }), 'SNSアカウントを追加');

  it("#49 kind: 'text' の項目の説明がラベルの後に描かれ、入力の aria-describedby が指す", () => {
    expectDescribed(dialog(), HANDLE_LABEL, HANDLE_DESCRIPTION);
  });

  it("#49 kind: 'secret' の項目の説明がラベルの後に描かれ、入力の aria-describedby が指す", () => {
    expectDescribed(dialog(), APP_PASSWORD_LABEL, APP_PASSWORD_DESCRIPTION);
  });
});

describe('#50 入れ直し・fields の項目の説明', () => {
  const dialog = (): string => dialogFrom(renderEditing(EXAMPLE_ACCOUNT), SET_CREDENTIAL);

  it("#50 kind: 'text' の項目の説明がラベルの後に描かれ、入力の aria-describedby が指す", () => {
    expectDescribed(dialog(), HANDLE_LABEL, HANDLE_DESCRIPTION);
  });

  it("#50 kind: 'secret' の項目の説明がラベルの後に描かれ、入力の aria-describedby が指す", () => {
    expectDescribed(dialog(), APP_PASSWORD_LABEL, APP_PASSWORD_DESCRIPTION);
  });
});

describe('#51 description が無い・空文字の項目では説明の要素も aria-describedby も無い', () => {
  const USER_LABEL = '利用者名（説明なし）';
  const TOKEN_LABEL = 'トークン（説明なし）';

  const providerWith = (description: string | undefined): ProviderOption => ({
    value: 'nodesc',
    label: '説明の無いSNS',
    credentialFields: [
      {
        key: 'user',
        label: USER_LABEL,
        kind: 'text',
        ...(description === undefined ? {} : { description }),
      },
      {
        key: 'token',
        label: TOKEN_LABEL,
        kind: 'secret',
        ...(description === undefined ? {} : { description }),
      },
    ],
    publisherRegistered: true,
  });

  const account: AccountRow = { ...EXAMPLE_ACCOUNT, provider: 'nodesc' };

  const cases = [
    { name: '省略', description: undefined },
    { name: "''", description: '' },
  ] as const;

  describe.each(cases)('description が $name', ({ description }) => {
    const creating = (): string =>
      dialogFrom(
        render({ initialCreating: true, providers: [providerWith(description)] }),
        'SNSアカウントを追加',
      );
    const editing = (): string =>
      dialogFrom(
        renderEditing(account, { providers: [providerWith(description)] }),
        SET_CREDENTIAL,
      );

    it("#51 アカウント追加：kind: 'text' の入力に aria-describedby が無い", () => {
      expect(inputAfter(creating(), USER_LABEL)).not.toContain('aria-describedby');
    });

    it("#51 アカウント追加：kind: 'secret' の入力に aria-describedby が無い", () => {
      expect(inputAfter(creating(), TOKEN_LABEL)).not.toContain('aria-describedby');
    });

    it('#51 アカウント追加：空の <p> を描かない', () => {
      expect(creating()).not.toMatch(/<p[^>]*><\/p>/);
    });

    it("#51 入れ直し：kind: 'text' の入力に aria-describedby が無い", () => {
      expect(inputAfter(editing(), USER_LABEL)).not.toContain('aria-describedby');
    });

    it("#51 入れ直し：kind: 'secret' の入力に aria-describedby が無い", () => {
      expect(inputAfter(editing(), TOKEN_LABEL)).not.toContain('aria-describedby');
    });

    it('#51 入れ直し：空の <p> を描かない', () => {
      expect(editing()).not.toMatch(/<p[^>]*><\/p>/);
    });
  });
});

describe('#52 description の HTML は解釈されずエスケープされる', () => {
  const MARKUP = '<b>強調</b>';

  const provider: ProviderOption = {
    value: 'markup',
    label: '説明にタグのあるSNS',
    credentialFields: [
      { key: 'user', label: '利用者名', kind: 'text', description: MARKUP },
      { key: 'token', label: 'トークン', kind: 'secret', description: MARKUP },
    ],
    publisherRegistered: true,
  };

  it('#52 アカウント追加：エスケープされた文字列（&lt;b&gt;）として描かれる', () => {
    const html = dialogFrom(
      render({ initialCreating: true, providers: [provider] }),
      'SNSアカウントを追加',
    );

    // text と secret の 2 つの欄の説明。
    expect(html.split('&lt;b&gt;強調&lt;/b&gt;').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('#52 アカウント追加：<b> 要素が無い', () => {
    const html = render({ initialCreating: true, providers: [provider] });

    expect(html).not.toContain('<b>');
  });

  it('#52 入れ直し：エスケープされた文字列として描かれ、<b> 要素が無い', () => {
    const html = renderEditing(
      { ...EXAMPLE_ACCOUNT, provider: 'markup' },
      { providers: [provider] },
    );

    expect(
      dialogFrom(html, SET_CREDENTIAL).split('&lt;b&gt;強調&lt;/b&gt;').length - 1,
    ).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain('<b>');
  });
});
