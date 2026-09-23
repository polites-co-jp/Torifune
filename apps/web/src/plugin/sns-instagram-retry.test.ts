import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PUBLISH_TIMEOUT_MS } from '@/domain/social/publishing';
import {
  MEDIA_PUBLISH_TIMEOUT_MS,
  PREPARE_BUDGET_MS,
  PUBLISH_TOTAL_BUDGET_MS,
} from '../../../../plugins/sns-instagram/graph';

/**
 * Instagram 配信 Plugin の `retryable` と制限時間の検査（038-sns-instagram 設計 §6.8 / §6.9 / §10.7〜§10.10）。
 *
 * **実際の Instagram を叩かない。**
 *
 * #97：`beforeEach` で `globalThis.fetch` を「呼ばれたら投げる」に置き換える。
 */

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  // #97：本物の `fetch` を呼んだら落ちる。差し替え忘れを検出する。
  realFetch = globalThis.fetch;
  globalThis.fetch = ((): never => {
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('制限時間の結線', () => {
  it('#72 準備の期限 ＋ 公開の制限時間は合計の期限に収まる', () => {
    // R4 を始めるのは準備が終わった後なので、両方の和が合計を超えると R4 が合計の期限で切られる。
    expect(PREPARE_BUDGET_MS + MEDIA_PUBLISH_TIMEOUT_MS).toBeLessThanOrEqual(
      PUBLISH_TOTAL_BUDGET_MS,
    );
  });

  it('#72 合計の期限は Core の 30 秒より 5 秒以上短い', () => {
    // 差の 5 秒は、打ち切りを検知して PublishResult を返すための余白（設計 §6.8）。
    // **Core の定数はテスト側で import する。** Plugin は Core を import しない。
    expect(PUBLISH_TOTAL_BUDGET_MS + 5_000).toBeLessThanOrEqual(PUBLISH_TIMEOUT_MS);
  });
});
