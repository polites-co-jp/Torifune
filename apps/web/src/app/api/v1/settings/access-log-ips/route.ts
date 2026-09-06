import { z } from 'zod';
import { updateAccessLogIpExclusions } from '@/application/analytics/ip-exclusion-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { accessLogIpExclusionSchema } from '@/api/schemas/analytics';
import {
  IP_EXCLUSION_MAX_RULES,
  IP_EXCLUSION_RULE_MAX_LENGTH,
} from '@/domain/analytics/ip-exclusion';

/**
 * アクセスログの除外IPの保存（033-analytics-ip-exclusion 設計 §8）。
 *
 * **`PUT /api/v1/settings`（表示名と同じ口）へ足さない。**
 * あの口の応答は `PublicSystemSettings`（未認証でも読んでよい項目）であり、
 * 除外リストを返せない。入力だけ相乗りさせると
 * 「送ったものが応答に無い」形になる。
 *
 * **`GET` を作らない。** 画面は Server Component から UseCase を直接呼ぶ
 * （決定事項 D-06）。社内の IP 帯が書かれた秘密を返す口は、要るまで生やさない。
 *
 * **`system.manage` の消費先。** 参照も更新も同じ権限を要る。
 */
export const PUT = defineRoute({
  operationId: 'updateAccessLogIpExclusions',
  method: 'PUT',
  path: '/settings/access-log-ips',
  summary: 'アクセスログに記録しない送信元IPを保存する',
  permission: 'system.manage',
  body: z.object({
    // **形式はここで見ない。** IP / CIDR として読めるかの判定は Domain にあり、
    // 2 か所に置くと片方だけ直る。ここは長さと件数だけを見る。
    rules: z
      .array(
        z
          .string()
          .max(
            IP_EXCLUSION_RULE_MAX_LENGTH,
            `${IP_EXCLUSION_RULE_MAX_LENGTH}文字以内で入力してください。`,
          ),
      )
      .max(IP_EXCLUSION_MAX_RULES, `${IP_EXCLUSION_MAX_RULES}件以内で指定してください。`),
    csrfToken: z.string().optional(),
  }),
  response: accessLogIpExclusionSchema,
  handler: async ({ context, body }) =>
    dataResponse(await updateAccessLogIpExclusions(context, { rules: body.rules })),
});
