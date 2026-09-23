import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonProps } from '@/ui/components';
import { ManualPending, type ManualPendingProps, type ManualPendingRow } from './manual-pending';

/**
 * 「手動投稿待ち」区画（035-social-publishing 設計 §7.1 / §7.2、受け入れ条件 #68）。
 *
 * 想定する props（Server Component が `listManualPendingPosts` と
 * 行ごとの `resolveManualHandoff` の結果をそのまま渡す。設計 §7.1）：
 *
 * ```ts
 * ManualPending({
 *   rows: {
 *     post: { id, accountName, body, scheduledAt };            // 日時は文字列で渡す
 *     handoff:
 *       | { ok: true; url: string; note: string | null }
 *       | { ok: false; reason: 'unsupported' | 'invalid_url' | 'plugin_error' };
 *   }[];
 *   canWrite: boolean;                                          // social.write を持つか（表示制御）
 *   open?: (url, name, features) => unknown;                    // 既定 window.open
 * })
 * ```
 *
 * * **URL は描画時に確定している。** `window.open` はクリックの同期処理の中で
 *   呼ばないとポップアップとして扱われず、ブロックされる（設計 §7.1）
 * * `open` を props にしてあるのは、この環境（vitest の `environment: 'node'`）に
 *   `window` が無く `vi.spyOn(window, 'open')` が使えないため（実装プラン §7 の 13 / §8 の 10）。
 *   既定値なので本番の経路は変わらない。
 *   **設計 §10 #68 は 2026-09-23 にこの形へ書き直された**（検証レポート §5 の 1）。
 *   もとの条件は `vi.spyOn(window, 'open')` と書いていたが、この環境では成立せず、
 *   **設計書の記述のほうが誤りだった。** 部品が `window` を直に触らないのは、
 *   Server / Client の境界を部品テストから外すためでもある
 * * 静的 HTML には `onClick` が出ないので、`@/ui/components` の `Button` を包んで
 *   props（ラベル・`onClick`・`disabled`）を記録し、ハンドラを直接呼ぶ
 */

const OPEN_LABEL = '投稿画面を開く';
const DONE_LABEL = '投稿した';
const CANCEL_LABEL = '取りやめ';

interface RecordedButton {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick?: (event: unknown) => void;
}

const capture = vi.hoisted(() => ({ buttons: [] as unknown[] }));

/** 子要素から文字を拾う（ラベルが要素で包まれていても引けるように）。 */
function textOfNode(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOfNode).join('');
  const props = (node as { props?: { children?: unknown } }).props;
  return props === undefined ? '' : textOfNode(props.children);
}

vi.mock('@/ui/components', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/ui/components');
  const Button = actual['Button'] as (props: ButtonProps) => ReactNode;
  return {
    ...actual,
    Button: (props: ButtonProps) => {
      capture.buttons.push(props);
      return Button(props);
    },
  };
});

function buttons(): readonly RecordedButton[] {
  return (capture.buttons as { children?: ReactNode; onClick?: unknown; disabled?: unknown }[]).map(
    (props) => ({
      label: textOfNode(props.children),
      disabled: props.disabled === true,
      ...(typeof props.onClick === 'function'
        ? { onClick: props.onClick as (event: unknown) => void }
        : {}),
    }),
  );
}

function buttonAt(label: string, index = 0): RecordedButton | undefined {
  return buttons().filter((button) => button.label.includes(label))[index];
}

const HANDOFF_OK = { ok: true, url: 'https://bsky.app/intent/compose?text=a', note: null } as const;

const ROW: ManualPendingRow = {
  post: {
    id: '01900000-0000-7000-8000-0000000000a1',
    accountName: '公式（テストSNS）',
    body: '新製品のお知らせ',
    scheduledAt: '2026-09-22T10:00:00.000Z',
  },
  handoff: HANDOFF_OK,
};

const SECOND_ROW: ManualPendingRow = {
  post: {
    id: '01900000-0000-7000-8000-0000000000a2',
    accountName: '公式（Bluesky）',
    body: 'もう一件の本文',
    scheduledAt: '2026-09-22T10:05:00.000Z',
  },
  handoff: { ok: true, url: 'https://bsky.app/intent/compose?text=b', note: null },
};

function render(overrides: Partial<ManualPendingProps> = {}): string {
  const props: ManualPendingProps = { rows: [ROW], canWrite: true, ...overrides };
  return renderToStaticMarkup(createElement(ManualPending, props));
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

/** ハンドラが `event.preventDefault()` を呼んでも落ちないための最小のイベント。 */
const clickEvent = { preventDefault: () => {}, stopPropagation: () => {} };

beforeEach(() => {
  capture.buttons.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ManualPending', () => {
  it('#68 行ごとに「投稿画面を開く」「投稿した」「取りやめ」を描く', () => {
    const text = textOf(render());

    expect(text).toContain(OPEN_LABEL);
    expect(text).toContain(DONE_LABEL);
    expect(text).toContain(CANCEL_LABEL);
  });

  it('#68 行のアカウント名と本文を描く', () => {
    const text = textOf(render());

    expect(text).toContain('公式（テストSNS）');
    expect(text).toContain('新製品のお知らせ');
  });

  it('#68 2 件なら操作の組が 2 つ並ぶ', () => {
    render({ rows: [ROW, SECOND_ROW] });

    expect(buttons().filter((button) => button.label.includes(OPEN_LABEL))).toHaveLength(2);
  });

  it('#68 rows が空なら何も描かない', () => {
    // 空の枠は見た目を崩す（設計 §7.1。`PluginWidgets` と同じ）。
    expect(render({ rows: [] })).toBe('');
  });

  it('#68 ダッシュボードから飛んで来られるよう id="manual-pending" を付ける', () => {
    // `/social#manual-pending`（設計 §7.6）。
    expect(render()).toContain('id="manual-pending"');
  });

  it('#68 見出しに件数を出す', () => {
    const text = textOf(render({ rows: [ROW, SECOND_ROW] }));

    expect(text).toMatch(/手動投稿待ち（2\s*件）/);
  });

  describe('子ウィンドウ（設計 §7.2）', () => {
    it('#68 「投稿画面を開く」の onClick が open を呼ぶ', () => {
      const open = vi.fn();
      render({ open });

      buttonAt(OPEN_LABEL)?.onClick?.(clickEvent);

      expect(open).toHaveBeenCalledTimes(1);
    });

    it('#68 open の第 1 引数が handoff の URL', () => {
      const open = vi.fn();
      render({ open });

      buttonAt(OPEN_LABEL)?.onClick?.(clickEvent);

      expect(open.mock.calls[0]?.[0]).toBe(HANDOFF_OK.url);
    });

    it('#68 窓の名前を torifune-manual-post に固定する', () => {
      // 同じ名前を使い回すので、2 件目を開いても窓が増えない（設計 §7.2）。
      const open = vi.fn();
      render({ open });

      buttonAt(OPEN_LABEL)?.onClick?.(clickEvent);

      expect(open.mock.calls[0]?.[1]).toBe('torifune-manual-post');
    });

    it('#68 features に noopener を含める', () => {
      // 開いた先から window.opener で Torifune の画面へ戻れる状態にしない（設計 §7.2）。
      const open = vi.fn();
      render({ open });

      buttonAt(OPEN_LABEL)?.onClick?.(clickEvent);

      expect(String(open.mock.calls[0]?.[2])).toMatch(/noopener/);
    });

    it('#68 features に noreferrer を含める', () => {
      const open = vi.fn();
      render({ open });

      buttonAt(OPEN_LABEL)?.onClick?.(clickEvent);

      expect(String(open.mock.calls[0]?.[2])).toMatch(/noreferrer/);
    });

    it('#68 2 件目を開くと 2 件目の URL で呼ばれる', () => {
      const open = vi.fn();
      render({ rows: [ROW, SECOND_ROW], open });

      buttonAt(OPEN_LABEL, 1)?.onClick?.(clickEvent);

      expect(open.mock.calls[0]?.[0]).toBe('https://bsky.app/intent/compose?text=b');
    });

    it('#68 ブロックされたときの逃げ道として同じ URL のリンクを併置する', () => {
      // noopener を付けると window.open は null を返し、ブロックを判別できない（設計 §7.2）。
      const html = render();

      expect(html).toContain(`href="${HANDOFF_OK.url}"`);
      expect(html).toMatch(/rel="noopener noreferrer"/);
      expect(html).toContain('target="_blank"');
    });
  });

  describe('開けない行（handoff.ok === false）', () => {
    function rowWith(reason: 'unsupported' | 'invalid_url' | 'plugin_error'): ManualPendingRow {
      return { post: ROW.post, handoff: { ok: false, reason } };
    }

    it('#68 「投稿画面を開く」が disabled になる', () => {
      render({ rows: [rowWith('unsupported')] });

      expect(buttonAt(OPEN_LABEL)?.disabled).toBe(true);
    });

    it('#68 開ける行の「投稿画面を開く」は disabled にしない', () => {
      render();

      expect(buttonAt(OPEN_LABEL)?.disabled).toBe(false);
    });

    it('#68 unsupported の理由を添える', () => {
      expect(textOf(render({ rows: [rowWith('unsupported')] }))).toContain(
        'この SNS の Plugin が無効です',
      );
    });

    it('#68 invalid_url の理由を添える', () => {
      expect(textOf(render({ rows: [rowWith('invalid_url')] }))).toContain(
        'Plugin が返した URL を開けません',
      );
    });

    it('#68 plugin_error の理由を添える', () => {
      expect(textOf(render({ rows: [rowWith('plugin_error')] }))).toContain(
        'Plugin でエラーが起きました',
      );
    });

    it('#68 「投稿した」は押せる', () => {
      // 人が別の手段で投稿した場合を閉ざさない（設計 §7.1）。
      render({ rows: [rowWith('unsupported')] });

      expect(buttonAt(DONE_LABEL)?.disabled).toBe(false);
    });

    it('#68 「取りやめ」は押せる', () => {
      render({ rows: [rowWith('unsupported')] });

      expect(buttonAt(CANCEL_LABEL)?.disabled).toBe(false);
    });

    it('#68 別のタブで開くリンクも出さない', () => {
      expect(render({ rows: [rowWith('invalid_url')] })).not.toContain('target="_blank"');
    });
  });

  describe('note（Plugin が添える注意書き）', () => {
    it('#68 note があれば出す', () => {
      const row: ManualPendingRow = {
        post: ROW.post,
        handoff: { ...HANDOFF_OK, note: '画像は投稿画面で添付してください' },
      };

      expect(textOf(render({ rows: [row] }))).toContain('画像は投稿画面で添付してください');
    });

    it('#68 note が null なら何も足さない', () => {
      const text = textOf(render());

      expect(text).not.toContain('画像は投稿画面で添付してください');
    });
  });

  describe('canWrite（表示制御であって認可ではない）', () => {
    it('#68 canWrite: false なら「投稿した」を出さない', () => {
      expect(textOf(render({ canWrite: false }))).not.toContain(DONE_LABEL);
    });

    it('#68 canWrite: false なら「取りやめ」を出さない', () => {
      expect(textOf(render({ canWrite: false }))).not.toContain(CANCEL_LABEL);
    });

    it('#68 canWrite: false でも行そのものは見える', () => {
      expect(textOf(render({ canWrite: false }))).toContain('新製品のお知らせ');
    });
  });
});
