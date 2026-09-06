import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AccessLogIpSettings, type AccessLogIpSettingsProps } from './access-log-ip-settings';

/**
 * 設定 → 一般の「アクセスログの除外IP」の区画
 * （033-analytics-ip-exclusion 設計 §10、受け入れ条件 #76〜#80）。
 *
 * 想定する props：
 *
 * ```ts
 * AccessLogIpSettings({
 *   rules: readonly string[];
 *   // いま画面を見ている人のアクセス元 IP。取れなければ null。
 *   clientIp: string | null;
 * })
 * ```
 *
 * **`canManage` を持たない。** この区画は `system.manage` を持つ人にしか
 * 描かれない（リストの表示自体が漏洩であるため。設計 §10）。
 * 「表示は誰でも、変更は権限持ち」という他の区画とは扱いが違う。
 *
 * `apiRequest` は差し替える。**描画で要求が飛ばないこと**もここで見る。
 */

const api = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('@/ui/client/api-client', () => ({
  apiRequest: api.request,
  apiUpload: vi.fn(),
  invalidateCsrfToken: vi.fn(),
  redirectToLogin: vi.fn(),
}));

function render(props: Partial<AccessLogIpSettingsProps> = {}): string {
  return renderToStaticMarkup(
    createElement(AccessLogIpSettings, {
      rules: ['203.0.113.10', '198.51.100.0/24'],
      clientIp: '203.0.113.10',
      ...props,
    }),
  );
}

describe('AccessLogIpSettings', () => {
  it('保存済みのルールを 1 行 1 件で入力欄に出す', () => {
    const html = render();

    expect(html).toContain('203.0.113.10');
    expect(html).toContain('198.51.100.0/24');
    expect(html).toContain('<textarea');
  });

  it('描画では API を叩かない', () => {
    api.request.mockClear();
    render();

    expect(api.request).not.toHaveBeenCalled();
  });

  /** #77 */
  it('現在のアクセス元 IP を出す', () => {
    expect(render({ clientIp: '198.51.100.42' })).toContain('198.51.100.42');
  });

  /** #77。取れないときは黙らない。プロキシの設定を疑えるようにする。 */
  it('アクセス元 IP が取れないときは注意文を出す', () => {
    const html = render({ clientIp: null });

    expect(html).toContain('判別できません');
    expect(html).toContain('プロキシ');
  });

  /** #78 */
  it('アクセス元 IP を追加するボタンを出す', () => {
    expect(render({ clientIp: '198.51.100.42', rules: [] })).toContain('追加');
  });

  /**
   * #78。既にリストへ入っている IP は足せない。
   *
   * **`disabled` を静的 HTML で見る。** 押せてしまうと重複行が増える。
   */
  it('既に含まれている IP の追加ボタンは押せない', () => {
    const html = render({ clientIp: '203.0.113.10', rules: ['203.0.113.10'] });
    const button = /<button[^>]*>追加<\/button>/.exec(html)?.[0] ?? '';

    expect(button).toContain('disabled');
  });

  it('含まれていない IP の追加ボタンは押せる', () => {
    const html = render({ clientIp: '198.51.100.42', rules: ['203.0.113.10'] });
    const button = /<button[^>]*>追加<\/button>/.exec(html)?.[0] ?? '';

    expect(button).not.toContain('disabled');
  });

  it('CIDR に含まれるだけの IP は追加できる（行そのものは無いため）', () => {
    const html = render({ clientIp: '198.51.100.42', rules: ['198.51.100.0/24'] });
    const button = /<button[^>]*>追加<\/button>/.exec(html)?.[0] ?? '';

    expect(button).not.toContain('disabled');
  });

  it('保存ボタンを出す', () => {
    expect(render()).toContain('保存する');
  });

  /**
   * #80。**できないことを画面で断る**（設計 §2 / §11）。
   *
   * `access_logs` に IP は残らないので、記録済みの分は後から探して消せない。
   * これを書いておかないと「除外したのに数字が減らない」と受け取られる。
   */
  it('すでに記録した分は消えないと断る', () => {
    const html = render();

    expect(html).toContain('すでに記録');
    expect(html).toContain('消えません');
  });

  it('CIDR で帯を指定できることを説明する', () => {
    expect(render()).toContain('/24');
  });
});
