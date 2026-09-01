import { z } from 'zod';
import { collectAccess } from '@/application/analytics/collect';
import { requestInfoOf } from '@/api/cookies';
import { noContentResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

/**
 * 計測の受け口（018-analytics 設計 §3.1）。
 *
 * **認証しない。** 計測タグは閲覧者のブラウザから叩かれる。
 * サイトの公開キーで識別し、**キーで読み出せるものは作らない**（書き込み専用）。
 *
 * 結果を出し分けない。成功しても失敗しても 204 を返す。
 * 出し分けると、キーの当たりを探る手段になる。
 */
export const POST = defineRoute({
  operationId: 'collectAccess',
  method: 'POST',
  path: '/collect',
  summary: 'アクセスを記録する',
  permission: null,
  reason: '計測タグは閲覧者のブラウザから叩かれる。認証できないため公開キーで識別する',
  // **他所のサイトから叩かれることが前提の口。** CSRF を検証すると
  // 正しい要求を必ず落とす。セッションに紐づく操作を一切していないため、
  // 検証しても守るものが無い。
  csrfExemptReason:
    '計測ビーコンは測定対象サイトのブラウザから送られる。セッションに紐づく操作を行わない',
  body: z.object({
    key: z.string().min(1).max(200),
    path: z.string().min(1).max(2000),
    referrer: z.string().max(2000).nullish(),
  }),
  // 公開の受け口。既定より緩めるが、1つのIPからの物量は止める。
  rateLimit: { windowMs: 60_000, max: 600 },
  // 公開APIの一覧には載せない。利用者が叩くためのものではない。
  documented: false,
  handler: async ({ request, body }) => {
    const info = requestInfoOf(request);

    await collectAccess({
      publicKey: body.key,
      path: body.path,
      referrer: body.referrer ?? null,
      ipAddress: info.ipAddress,
      userAgent: info.userAgent,
    });

    // 記録できたかを返さない。
    return noContentResponse();
  },
});
