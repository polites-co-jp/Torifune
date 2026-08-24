/**
 * プロセス内で1つだけ持ちたい状態の置き場。
 *
 * **モジュールの変数に置くだけでは足りない。**
 * Next.js は Route Handler・Server Component・Middleware を別々のバンドルへ
 * 分けることがあり、同じファイルの実体が複数になる。
 * そうなると「API で無効化したのに画面から消えない」という壊れ方をする。
 *
 * 開発時の HMR でも同じことが起きる。
 *
 * `globalThis` へ置いて、プロセスに1つであることを保証する。
 */

const STATE_KEY = Symbol.for('torifune.plugin.process-state');

interface Holder {
  [STATE_KEY]?: Map<string, unknown>;
}

function holder(): Map<string, unknown> {
  const target = globalThis as unknown as Holder;
  target[STATE_KEY] ??= new Map<string, unknown>();
  return target[STATE_KEY];
}

/**
 * 名前つきの状態を1つだけ作る。
 *
 * 同じ名前で2度呼んでも、最初に作ったものが返る。
 */
export function processState<T>(name: string, create: () => T): T {
  const store = holder();
  if (!store.has(name)) {
    store.set(name, create());
  }
  return store.get(name) as T;
}
