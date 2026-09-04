import { regenerateSitePublicKey } from '@/application/site/site-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { regenerateSitePublicKeySchema, sitePublicKeyEnvelopeSchema } from '@/api/schemas/site';

export const POST = defineRoute({
  operationId: 'regenerateSitePublicKey',
  method: 'POST',
  path: '/sites/{id}/public-key',
  summary: 'Webサイトの計測用公開キーを再発行する',
  permission: 'site.write',
  body: regenerateSitePublicKeySchema,
  response: sitePublicKeyEnvelopeSchema,
  handler: async ({ context, params }) => {
    // 旧キーは即時に無効になる。新しいキーは応答でだけ返す（一般の取得には出さない）。
    const result = await regenerateSitePublicKey(context, { id: params['id'] ?? '' });
    return dataResponse({ siteId: result.siteId, publicKey: result.publicKey });
  },
});
