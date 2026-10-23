import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/social/history` の転送（055-social-pending-tab 設計 §9.7、受け入れ条件 #70 の単体側。検証 1 回目 spec 軽微-2・変異 M14）。
 *
 * 転送は `status` が `published` / `failed` のときだけ `historyStatus` に、`page` は 2 以上のときだけ `historyPage` に写し、
 * **それ以外の値は落とす**（任意の値を転送先へ写さない）。転送先の `page.tsx` も検査し直すので画面は壊れないが、
 * ここでは転送そのものが検査することを見る（E2E #70 は `page=abc` だけを見ている）。
 *
 * `redirect`（`next/navigation`）は外部境界なので差し替え、渡された URL を捕まえる（本物は例外を投げて処理を止める）。
 */

const capture = vi.hoisted(() => ({ redirects: [] as string[] }));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    capture.redirects.push(url);
    throw new Error('NEXT_REDIRECT');
  },
}));

type Params = Record<string, string | string[] | undefined>;

async function redirectedTo(params: Params): Promise<string> {
  const module = (await import('@/app/social/history/page')) as {
    default: (props: { searchParams: Promise<Params> }) => Promise<unknown>;
  };
  await module.default({ searchParams: Promise.resolve(params) }).catch((error: unknown) => {
    if (!(error instanceof Error) || error.message !== 'NEXT_REDIRECT') throw error;
  });
  expect(capture.redirects, 'redirect が 1 回呼ばれる').toHaveLength(1);
  return capture.redirects[0] as string;
}

beforeEach(() => {
  capture.redirects.length = 0;
});

describe('#70 /social/history の転送は status を検査する（設計 §9.7）', () => {
  it('#70 status=failed&page=2 → /social?tab=history&historyStatus=failed&historyPage=2', async () => {
    expect(await redirectedTo({ status: 'failed', page: '2' })).toBe(
      '/social?tab=history&historyStatus=failed&historyPage=2',
    );
  });

  it('#70 status=published → historyStatus=published', async () => {
    expect(await redirectedTo({ status: 'published' })).toBe(
      '/social?tab=history&historyStatus=published',
    );
  });

  it.each([
    ['知らない値', 'xxx'],
    ['大文字', 'FAILED'],
    ['下書き（配信履歴の結果ではない）', 'draft'],
    ['空', ''],
  ])('#70 status が%s（%s）→ historyStatus を写さない', async (_label, status) => {
    const href = await redirectedTo({ status, page: '2' });

    expect(href).toBe('/social?tab=history&historyPage=2');
    expect(href).not.toContain('historyStatus');
  });

  it('#70 status が配列 → historyStatus を写さない', async () => {
    const href = await redirectedTo({ status: ['failed'] });

    expect(href).toBe('/social?tab=history');
  });

  it('#70 page=abc → historyPage を写さない（/social?tab=history）', async () => {
    expect(await redirectedTo({ page: 'abc' })).toBe('/social?tab=history');
  });

  it('#70 他のクエリ（postStatus など）は写さない', async () => {
    const href = await redirectedTo({ status: 'failed', postStatus: 'draft', from: 'x' });

    expect(href).toBe('/social?tab=history&historyStatus=failed');
  });
});
