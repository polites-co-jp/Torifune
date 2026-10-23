import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonProps } from '@/ui/components';
import { SocialPostForm, type AccountOption, type SocialPostFormProps } from './social-post-form';

/**
 * 投稿フォームの戻り先（055-social-pending-tab 設計 §5.7・§9.12、受け入れ条件 #60、実装プラン §8 の 18）。
 *
 * 保存・キャンセルで戻る先を、開いたタブにする。`SocialPostForm` の新しい props **`returnTo`（任意）**：
 * 送信待ちタブの「編集」「+ 投稿を作成」（`?from=pending`）からは `/social`、それ以外は `/social?tab=posts`
 * （`from` の読み方は `postFormReturnTo`。`social-tabs.test.ts`）。**渡さないときの既定は `/social?tab=posts`**
 * （必須にすると props をオブジェクトリテラルで組む既存のテストが型で落ちる。§8 の 18）。
 *
 * 単体テストの環境には DOM が無いので、`apiRequest` を成功で差し替え（§8 の 21）、`<form>` の `onSubmit` と
 * キャンセルの `Button` の `onClick` を捕まえて直接呼び、`window.location.assign` を差し替えて行き先を見る。
 * `<form>` は部品ではない要素なので、JSX の変換先（`react/jsx-runtime`・`react/jsx-dev-runtime`）を包んで
 * `form` の props を捕まえる。保存の処理が読む `FormData` はブラウザの API なので、欄の値を返す偽物に差し替える
 * （外部境界のモック。`FormData` は Node にもあるが `<form>` 要素からは作れない）。
 * 保存を `<form>` の `onSubmit` ではなく保存のボタンの `onClick` で行う形にしても見られるよう、両方を試す。
 * `returnTo` はまだ props の型に無いので、型をテストに写して `as` で渡す（053 実装プラン §8 の 44）。
 */

const capture = vi.hoisted(() => ({
  buttons: [] as unknown[],
  forms: [] as unknown[],
  apiRequest: vi.fn(),
}));

vi.mock('@/ui/client/api-client', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/ui/client/api-client');
  return { ...actual, apiRequest: capture.apiRequest };
});

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

/** `<form>` の props を捕まえる（JSX の変換先を包む）。 */
function wrapJsx(actual: Record<string, unknown>): Record<string, unknown> {
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of ['jsx', 'jsxs', 'jsxDEV']) {
    const original = actual[name];
    if (typeof original !== 'function') continue;
    wrapped[name] = (type: unknown, props: unknown, ...rest: unknown[]) => {
      if (type === 'form') capture.forms.push(props);
      return (original as (...args: unknown[]) => unknown)(type, props, ...rest);
    };
  }
  return wrapped;
}

vi.mock('react/jsx-runtime', async () =>
  wrapJsx(await vi.importActual<Record<string, unknown>>('react/jsx-runtime')),
);
vi.mock('react/jsx-dev-runtime', async () =>
  wrapJsx(await vi.importActual<Record<string, unknown>>('react/jsx-dev-runtime')),
);

type ReturnProps = SocialPostFormProps & { readonly returnTo?: string };

const Component = SocialPostForm as unknown as ComponentType<ReturnProps>;

const ACCOUNT: AccountOption = {
  id: '01900000-0000-7000-8000-0000000055a1',
  label: '公式（テストSNS）',
  manualSupported: true,
};

const POST_ID = '01900000-0000-7000-8000-0000000055b1';

function props(overrides: Partial<ReturnProps> = {}): ReturnProps {
  return {
    title: '投稿を編集',
    initial: {
      socialAccountId: ACCOUNT.id,
      body: '秋のセールの告知',
      scheduledAtIso: null,
      status: 'draft',
      deliveryMode: 'auto',
    },
    accounts: [ACCOUNT],
    postId: POST_ID,
    ...overrides,
  };
}

function render(overrides: Partial<ReturnProps> = {}): string {
  return renderToStaticMarkup(createElement(Component, props(overrides)));
}

/** 欄の値を返す `FormData` の偽物。 */
class FakeFormData {
  private readonly values: Record<string, string> = {
    socialAccountId: ACCOUNT.id,
    body: '秋のセールの告知（直した）',
    scheduledAt: '',
    status: 'draft',
  };

  get(name: string): string | null {
    return this.values[name] ?? null;
  }
}

function textOfNode(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOfNode).join('');
  const nodeProps = (node as { props?: { children?: unknown } }).props;
  return nodeProps === undefined ? '' : textOfNode(nodeProps.children);
}

function recordedButton(label: string): ButtonProps | undefined {
  return (capture.buttons as ButtonProps[]).find(
    (button) => textOfNode(button.children).trim() === label,
  );
}

/** 描画の後にブラウザの API を差し替える（描画そのものは `window` の無い環境のまま）。 */
function stubBrowser(): void {
  vi.stubGlobal('window', { location: { assign } });
  vi.stubGlobal('FormData', FakeFormData);
}

/** キャンセルを押す。 */
function cancel(): void {
  stubBrowser();
  (recordedButton('キャンセル')?.onClick as ((event: unknown) => void) | undefined)?.({});
}

/** 保存を行う：`<form>` の `onSubmit` か、保存のボタンの `onClick`。 */
async function submit(): Promise<void> {
  stubBrowser();
  const event = {
    preventDefault: () => {},
    stopPropagation: () => {},
    currentTarget: {},
    target: {},
  };
  const form = (capture.forms as { onSubmit?: unknown }[]).find(
    (candidate) => typeof candidate.onSubmit === 'function',
  );
  if (form !== undefined) {
    await (form.onSubmit as (event: unknown) => unknown)(event);
    return;
  }
  const save = recordedButton('保存');
  if (typeof save?.onClick === 'function') {
    await (save.onClick as (event: unknown) => unknown)(event);
    return;
  }
  throw new Error('保存の onSubmit / onClick を捕まえられない');
}

let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  capture.buttons.length = 0;
  capture.forms.length = 0;
  capture.apiRequest.mockReset();
  capture.apiRequest.mockResolvedValue({ ok: true, data: { id: POST_ID } });
  assign = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('#60 保存の成功で returnTo を開く', () => {
  it("#60 returnTo: '/social'（送信待ちタブから）なら保存の後に /social を 1 回開く", async () => {
    render({ returnTo: '/social' });

    await submit();

    expect(capture.apiRequest).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls).toEqual([['/social']]);
  });

  it("#60 returnTo: '/social?tab=posts'（投稿タブから）なら /social?tab=posts を開く", async () => {
    render({ returnTo: '/social?tab=posts' });

    await submit();

    expect(assign.mock.calls).toEqual([['/social?tab=posts']]);
  });

  it('#60 returnTo を渡さないときは /social?tab=posts（§8 の 18）', async () => {
    render();

    await submit();

    expect(assign.mock.calls).toEqual([['/social?tab=posts']]);
  });

  it('#60 新規作成でも returnTo を開く', async () => {
    render({ title: '投稿を作成', postId: undefined, returnTo: '/social' });

    await submit();

    expect(capture.apiRequest.mock.calls[0]?.[0]).toBe('/api/v1/social/posts');
    expect(assign.mock.calls).toEqual([['/social']]);
  });

  it('#60 保存に失敗したら開かない', async () => {
    capture.apiRequest.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: '入力を確かめてください。', status: 422 },
    });
    render({ returnTo: '/social' });

    await submit();

    expect(assign).not.toHaveBeenCalled();
  });
});

describe('#60 キャンセルも returnTo を開く', () => {
  it("#60 returnTo: '/social' ならキャンセルで /social を 1 回開く", () => {
    render({ returnTo: '/social' });

    cancel();

    expect(assign.mock.calls).toEqual([['/social']]);
  });

  it('#60 returnTo を渡さないときはキャンセルで /social?tab=posts', () => {
    render();

    cancel();

    expect(assign.mock.calls).toEqual([['/social?tab=posts']]);
  });

  it('#60 キャンセルでは保存しない', () => {
    render({ returnTo: '/social' });

    cancel();

    expect(capture.apiRequest).not.toHaveBeenCalled();
  });
});
