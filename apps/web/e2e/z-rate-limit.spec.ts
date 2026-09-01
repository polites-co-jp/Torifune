import { expect, test } from '@playwright/test';

/**
 * 既定の Rate Limit（05_API設計.md §36、docs/設計/022-hardening/設計.md §3.2）。
 *
 * **このファイルは最後に実行される必要がある。**
 * 上限（IP ＋ operationId ごとに 300回/分）を意図的に使い切るため、
 * 同じエンドポイントを使う後続のテストが 429 に巻き込まれる。
 * ファイル名の `z-` は実行順を最後にするためのもので、消さないこと。
 */

test('一覧APIにも既定の Rate Limit がかかり、429 と Retry-After を返す', async ({ request }) => {
  let retryAfter: string | undefined;

  // 上限に達するまで叩く。余裕を見て上限より多く試す。
  for (let i = 0; i < 340; i += 1) {
    const response = await request.get('/api/v1/sites?perPage=1');
    if (response.status() === 429) {
      retryAfter = response.headers()['retry-after'];
      break;
    }
  }

  expect(retryAfter).toBeDefined();
  // 何秒後に再試行してよいかを伝えないと、クライアントは総当たりで再試行する。
  expect(Number(retryAfter)).toBeGreaterThan(0);
});
