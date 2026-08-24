/**
 * イベントの発火（03_プラグイン設計.md §6）。
 *
 * 購読側は `011-plugin-runtime` で繋ぐ。ここでは**発火の口だけ**を用意する。
 *
 * **ハンドラの失敗が発火元を巻き込まない。**
 * Plugin の不具合で本体の処理が失敗すると、Plugin を入れた瞬間に
 * サイトが作れなくなる、という壊れ方をする。
 */

import { processState } from '@/infrastructure/process-state';

export type EventHandler = (payload: unknown) => void | Promise<void>;

// **プロセスに1つ。** 理由は `infrastructure/process-state.ts`。
// 分かれると、Plugin が購読したのに発火が届かない、という壊れ方をする。
const handlers = processState('events.handlers', () => new Map<string, EventHandler[]>());

export function subscribe(eventName: string, handler: EventHandler): () => void {
  const list = handlers.get(eventName) ?? [];
  list.push(handler);
  handlers.set(eventName, list);

  return () => {
    const current = handlers.get(eventName) ?? [];
    handlers.set(
      eventName,
      current.filter((registered) => registered !== handler),
    );
  };
}

export async function emit(eventName: string, payload: unknown): Promise<void> {
  for (const handler of handlers.get(eventName) ?? []) {
    try {
      await handler(payload);
    } catch {
      // 購読側の失敗は握る。発火元の処理を巻き込まない。
      // 記録は 011-plugin-runtime で Plugin ごとのログへ回す。
    }
  }
}

/** テスト用。 */
export function resetEventHandlers(): void {
  handlers.clear();
}

/** 発火済みイベントを覗く口（テストと監査用）。 */
export function subscriberCount(eventName: string): number {
  return (handlers.get(eventName) ?? []).length;
}
