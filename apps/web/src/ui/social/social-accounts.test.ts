import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SocialAccounts, type SocialAccountsProps } from './social-accounts';

// 039-social-credential-fields：部品が保存・消去の後に `router.refresh()` を呼ぶ（設計 §7.3.4）。
// `useRouter` は App Router の外では例外を投げるので差し替える（設計 #42 が許す唯一の変更）。
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

/**
 * SNS アカウントの追加（035-social-publishing 設計 §7.5、受け入れ条件 #71）。
 *
 * 足す props（実装プラン T23。**いまの固定 5 択と自前の `PROVIDER_LABEL` を置き換える**）：
 *
 * ```ts
 * SocialAccounts({
 *   …既存,
 *   providers: {
 *     value: string;
 *     label: string;                                  // publisher の label を優先（設計 §5.6.1）
 *     credentialFields: { key: string; label: string; kind: 'text' | 'secret' }[];
 *   }[];
 *   // 追加の Modal を開いた状態で描く。既定 false（Server Component は渡さない）。
 *   // Node 環境の単体テストには DOM が無く、ボタンを押して開けないため。
 *   initialCreating?: boolean;
 * })
 * ```
 *
 * * `credentialFields` があれば**項目ごとに入力欄**（`kind: 'secret'` は `SecretField`）。
 *   無ければ従来どおり 1 つの `SecretField`（`credential`）
 * * **保存後は再表示しない**（`06` §38）。一覧は `credentialConfigured` の「••••••••」だけ
 * * 既存の E2E（provider `x` に `credential` を送る、マスク表示）はそのまま通ること
 *
 * **「`Modal` を閉じると入力値が消える」はここでは見ない**（設計 §10 #71 の書き直し、
 * 2026-09-23。検証レポート §5 の 2）。vitest に DOM が無く、`Modal` の開閉に伴う
 * 再マウントを部品テストで踏めないため、**(A) 単体では観測できない。**
 * その保証は **E2E #76**（開いて入力 → 閉じる → 開き直すと空）が引き取っている。
 * 「実装はあるのに条件が無い」でも「条件はあるのに観測できない」でもない形にする。
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

const ACCOUNT = {
  id: '01900000-0000-7000-8000-0000000000a1',
  provider: 'bluesky',
  displayName: 'とりふね公式',
  handle: '@torifune',
  status: 'connected',
  credentialConfigured: true,
};

const BASE: SocialAccountsProps = {
  initialAccounts: [ACCOUNT],
  permissions: ['social.read', 'social.write', 'social.delete'],
  providers: PROVIDERS,
};

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

function passwordInputs(html: string): string[] {
  return [...html.matchAll(/<input[^>]*type="password"[^>]*>/g)].map((match) => match[0]);
}

describe('SocialAccounts の一覧', () => {
  it('#71 「サービス」列に providers の表示名を使う', () => {
    // publisher の label を優先する（設計 §5.6.1）。固定 5 択の自前表を持たない。
    expect(textOf(render())).toContain('Bluesky');
  });

  it('#71 providers に無い provider は値をそのまま出す', () => {
    const text = textOf(render({ initialAccounts: [{ ...ACCOUNT, provider: 'mastodon' }] }));

    expect(text).toContain('mastodon');
  });

  it('#71 資格情報は「••••••••」で、平文を出さない', () => {
    // 既存の E2E が見ている表示（#79）。
    expect(textOf(render())).toContain('••••••••');
  });

  it('#71 未設定のアカウントは「未設定」', () => {
    const text = textOf(render({ initialAccounts: [{ ...ACCOUNT, credentialConfigured: false }] }));

    expect(text).toContain('未設定');
  });
});

describe('アカウント追加の資格情報の欄', () => {
  it('#71 「サービス」の選択肢を providers から作る', () => {
    const html = render({ initialCreating: true });

    expect(html).toMatch(/<option[^>]*value="bluesky"[^>]*>Bluesky<\/option>/);
    expect(html).toMatch(/<option[^>]*value="x"[^>]*>X<\/option>/);
  });

  it('#71 部品の中に固定の選択肢を持たない', () => {
    // いまは `youtube` などが部品に直書きされている（実装プラン §7 の 16）。
    const html = render({ initialCreating: true });

    expect(html).not.toContain('value="youtube"');
    expect(html).not.toContain('value="facebook"');
  });

  it('#71 credentialFields を持つ provider では項目ごとの欄を出す', () => {
    const text = textOf(render({ initialCreating: true }));

    expect(text).toContain('識別子');
    expect(text).toContain('アプリパスワード');
  });

  it('#71 kind: secret の項目は伏せて入力する', () => {
    const html = render({ initialCreating: true });

    expect(html).toMatch(/アプリパスワード[\s\S]{0,400}?type="password"/);
  });

  it('#71 kind: text の項目は伏せない', () => {
    // 伏せるかどうかは入力欄の見え方だけの違い（設計 §5.7）。保存はどちらも暗号化される。
    const html = render({ initialCreating: true });
    const beforeSecretLabel = html.slice(0, html.indexOf('アプリパスワード'));

    expect(beforeSecretLabel).toContain('識別子');
    expect(passwordInputs(beforeSecretLabel)).toHaveLength(0);
  });

  it('#71 credentialFields を持つ provider では従来の 1 つの資格情報欄を出さない', () => {
    const text = textOf(render({ initialCreating: true }));

    expect(text).not.toContain('資格情報（アクセストークン等）');
  });

  it('#71 credentialFields が空の provider では 1 つの資格情報欄を出す', () => {
    const html = render({
      initialCreating: true,
      providers: [PROVIDERS[1]!, PROVIDERS[0]!],
    });

    expect(textOf(html)).toContain('資格情報');
    expect(passwordInputs(html)).toHaveLength(1);
  });

  it('#71 credentialFields が空の provider では項目ごとの欄を出さない', () => {
    const text = textOf(render({ initialCreating: true, providers: [PROVIDERS[1]!] }));

    expect(text).not.toContain('識別子');
    expect(text).not.toContain('アプリパスワード');
  });

  it('#71 Modal を開いていなければ入力欄は描かれない', () => {
    const html = render();

    expect(passwordInputs(html)).toHaveLength(0);
    expect(textOf(html)).not.toContain('識別子');
  });

  it('#71 保存済みの平文を入力欄へ戻さない', () => {
    // `SecretField` は設定済みの値を受け取らない（`06` §38）。
    const html = render({ initialCreating: true });

    for (const input of passwordInputs(html)) {
      expect(input).not.toMatch(/\svalue="[^"]/);
    }
  });
});
