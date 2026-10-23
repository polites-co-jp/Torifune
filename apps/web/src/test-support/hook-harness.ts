/**
 * DOM の無い単体テストで、状態（`useState`）を持つ部品を「押して・描き直す」ための小さな描画器
 * （055-social-pending-tab 実装プラン §8 の 78）。
 *
 * `renderToStaticMarkup` は 1 回描くだけで、描画の後の `setState` は何もしない（054 実装プラン §8 の 20）。
 * そのため「ボタンを押すとダイアログが開き、その中のボタンで要求を送る」「保存中はボタンが `disabled`」
 * 「失敗の後に出る文言」のような、**描画の後の状態**を単体テストで見られない。ここでは DOM の環境を足さず、
 *
 * 1. テストのファイルで `react` を `vi.mock` し、`useState` などを {@link withHookHarness} の差し替えに替える
 *    （描画器が動いていないときは本物に任せるので、同じファイルの `renderToStaticMarkup` はそのまま動く）
 * 2. {@link hookHarness} の `render(element)` が部品を**関数として**呼び、返った要素を辿って
 *    素の要素（`<button>`・`<input>` など）の props と文字を集める
 * 3. テストは集めた `onClick` / `onChange` を呼び、もう一度 `render` して描き直した結果を見る
 *
 * フックの状態は「部品の置き場（親からの位置と部品の名前）＋呼んだ順」で持つ。React と同じく、
 * フックは毎回同じ順に呼ばれる前提（フックの規則）に立つ。`useEffect` は走らせない（外への作用を起こさない）。
 * `leaves` に入れた部品（`next/link` のような外部の部品）は呼ばずに葉として扱い、子だけを辿る。
 *
 * **このファイルは `react` を import しない**（`vi.mock('react')` の中から読むため）。
 */

/** 集めた素の要素。`text` は子孫の文字をつないだもの。 */
export interface HostNode {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: readonly HostNode[];
  readonly text: string;
}

interface ElementLike {
  readonly $$typeof: symbol;
  readonly type: unknown;
  readonly props: Record<string, unknown>;
}

interface Frame {
  readonly key: string;
  index: number;
}

const FORWARD_REF = Symbol.for('react.forward_ref');
const MEMO = Symbol.for('react.memo');

function isElement(value: unknown): value is ElementLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    '$$typeof' in value &&
    'type' in value &&
    'props' in value
  );
}

function textNode(value: string): HostNode {
  return { type: '#text', props: {}, children: [], text: value };
}

function hostNode(
  type: string,
  props: Readonly<Record<string, unknown>>,
  children: readonly HostNode[],
): HostNode {
  return { type, props, children, text: children.map((child) => child.text).join('') };
}

function nameOf(type: unknown): string {
  if (typeof type === 'function') return type.name || 'anonymous';
  return 'object';
}

class HookHarness {
  private readonly slots = new Map<string, unknown[]>();
  private frame: Frame | null = null;
  private rendering = false;
  readonly leaves = new Set<unknown>();

  /** 描画器が部品を呼んでいる最中か（差し替えのフックが本物に任せるかを決める）。 */
  get active(): boolean {
    return this.rendering && this.frame !== null;
  }

  /** 状態を捨てる（テストの間で持ち越さない）。 */
  reset(): void {
    this.slots.clear();
    this.frame = null;
    this.rendering = false;
  }

  /** 要素を描き、素の要素の並びを返す。2 回目以降は前の状態を使って描き直す。 */
  render(element: unknown): readonly HostNode[] {
    this.rendering = true;
    try {
      return this.renderNode(element, 'root');
    } finally {
      this.rendering = false;
      this.frame = null;
    }
  }

  private nextSlot(): { readonly values: unknown[]; readonly index: number } {
    const frame = this.frame;
    if (frame === null) throw new Error('hook-harness: 部品の外でフックが呼ばれた');
    let values = this.slots.get(frame.key);
    if (values === undefined) {
      values = [];
      this.slots.set(frame.key, values);
    }
    const index = frame.index;
    frame.index += 1;
    return { values, index };
  }

  useState<T>(initial: T | (() => T)): [T, (next: T | ((previous: T) => T)) => void] {
    const { values, index } = this.nextSlot();
    if (!(index in values)) {
      values[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
    }
    const setter = (next: T | ((previous: T) => T)): void => {
      const previous = values[index] as T;
      values[index] =
        typeof next === 'function' ? (next as (previous: T) => T)(previous) : (next as T);
    };
    return [values[index] as T, setter];
  }

  useRef<T>(initial: T): { current: T } {
    const { values, index } = this.nextSlot();
    if (!(index in values)) {
      values[index] = { current: initial };
    }
    return values[index] as { current: T };
  }

  useId(): string {
    const key = this.frame?.key ?? '';
    const { index } = this.nextSlot();
    return `hh-${key}-${index}`;
  }

  private callComponent(
    type: (props: Record<string, unknown>, ref?: unknown) => unknown,
    props: Record<string, unknown>,
    key: string,
    asForwardRef: boolean,
  ): unknown {
    const previous = this.frame;
    this.frame = { key, index: 0 };
    try {
      return asForwardRef ? type(props, null) : type(props);
    } finally {
      this.frame = previous;
    }
  }

  private renderNode(node: unknown, path: string): HostNode[] {
    if (node === null || node === undefined || typeof node === 'boolean') return [];
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'bigint') {
      return [textNode(String(node))];
    }
    if (Array.isArray(node)) {
      return node.flatMap((child, index) => this.renderNode(child, `${path}.${index}`));
    }
    if (!isElement(node)) return [];

    const { type, props } = node;
    if (typeof type === 'string') {
      return [hostNode(type, props, this.renderNode(props['children'], `${path}>${type}`))];
    }
    if (this.leaves.has(type)) {
      return [
        hostNode(`leaf:${nameOf(type)}`, props, this.renderNode(props['children'], `${path}>leaf`)),
      ];
    }
    if (typeof type === 'function') {
      const key = `${path}>${nameOf(type)}`;
      const output = this.callComponent(
        type as (props: Record<string, unknown>) => unknown,
        props,
        key,
        false,
      );
      return this.renderNode(output, key);
    }
    if (typeof type === 'object' && type !== null && '$$typeof' in type) {
      const kind = (type as { $$typeof: symbol }).$$typeof;
      if (kind === FORWARD_REF) {
        const render = (
          type as unknown as { render: (props: Record<string, unknown>, ref: unknown) => unknown }
        ).render;
        const key = `${path}>forwardRef`;
        return this.renderNode(
          this.callComponent(
            render as (props: Record<string, unknown>) => unknown,
            props,
            key,
            true,
          ),
          key,
        );
      }
      if (kind === MEMO) {
        return this.renderNode(
          { ...node, type: (type as unknown as { type: unknown }).type } satisfies ElementLike,
          path,
        );
      }
    }
    // Fragment・Context・StrictMode などは子だけを辿る。
    return this.renderNode(props['children'], `${path}>frag`);
  }
}

/** テストのファイルで共有する描画器（`vi.mock('react')` の差し替えと同じ実体）。 */
export const hookHarness = new HookHarness();

interface ReactHooks {
  readonly useState: (...args: never[]) => unknown;
  readonly useEffect: (...args: never[]) => unknown;
  readonly useLayoutEffect: (...args: never[]) => unknown;
  readonly useRef: (...args: never[]) => unknown;
  readonly useId: (...args: never[]) => unknown;
}

/**
 * `react` の差し替えを作る。描画器が部品を呼んでいる最中だけ差し替えのフックを使い、他は本物に任せる。
 *
 * ```ts
 * vi.mock('react', async (importOriginal) => {
 *   const { withHookHarness } = await import('@/test-support/hook-harness');
 *   return withHookHarness(await importOriginal());
 * });
 * ```
 */
export function withHookHarness(original: unknown): Record<string, unknown> {
  const actual = original as ReactHooks & Record<string, unknown>;
  const call = (name: keyof ReactHooks, args: unknown[]): unknown =>
    (actual[name] as (...values: unknown[]) => unknown)(...args);
  return {
    ...actual,
    default: actual,
    useState: (...args: unknown[]) =>
      hookHarness.active ? hookHarness.useState(args[0]) : call('useState', args),
    useRef: (...args: unknown[]) =>
      hookHarness.active ? hookHarness.useRef(args[0]) : call('useRef', args),
    useId: (...args: unknown[]) => (hookHarness.active ? hookHarness.useId() : call('useId', args)),
    useEffect: (...args: unknown[]) => (hookHarness.active ? undefined : call('useEffect', args)),
    useLayoutEffect: (...args: unknown[]) =>
      hookHarness.active ? undefined : call('useLayoutEffect', args),
  };
}

/* -------------------------------------------------------------------------- */
/* 集めた要素の読み方                                                             */
/* -------------------------------------------------------------------------- */

/** 条件に合う要素を、文書の順に（深さ優先で）すべて返す。 */
export function findAll(
  nodes: readonly HostNode[],
  predicate: (node: HostNode) => boolean,
): HostNode[] {
  const found: HostNode[] = [];
  const visit = (list: readonly HostNode[]): void => {
    for (const node of list) {
      if (predicate(node)) found.push(node);
      visit(node.children);
    }
  };
  visit(nodes);
  return found;
}

/** 見える文字（前後の空白を落とす）がちょうど `label` の `<button>`。 */
export function buttonsLabelled(nodes: readonly HostNode[], label: string): HostNode[] {
  return findAll(nodes, (node) => node.type === 'button' && node.text.trim() === label);
}

/** 描かれた文字をすべてつないだもの。 */
export function textOfNodes(nodes: readonly HostNode[]): string {
  return nodes.map((node) => node.text).join('');
}

/** 要素の `onClick` を呼ぶ（無ければ失敗）。 */
export function click(node: HostNode | undefined): unknown {
  const onClick = node?.props['onClick'];
  if (typeof onClick !== 'function') throw new Error('hook-harness: onClick が無い');
  return (onClick as (event: unknown) => unknown)({
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  });
}

/** 要素の `onChange` に値を入れる（無ければ失敗）。 */
export function change(node: HostNode | undefined, value: string): void {
  const onChange = node?.props['onChange'];
  if (typeof onChange !== 'function') throw new Error('hook-harness: onChange が無い');
  (onChange as (event: unknown) => void)({ target: { value }, currentTarget: { value } });
}

/** 待ち行列に積まれた Promise の続きを流す（`await apiRequest(…)` の後の `setState` まで）。 */
export async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
