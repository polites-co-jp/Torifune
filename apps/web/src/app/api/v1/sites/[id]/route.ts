import { deleteSite, getSite, updateSite } from '@/application/site/site-use-cases';
import { dataResponse, noContentResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import { toSiteResponse, updateSiteSchema } from '@/api/schemas/site';
import { z } from 'zod';

export const GET = defineRoute({
  operationId: 'getSite',
  method: 'GET',
  path: '/sites/{id}',
  summary: 'Webサイトを取得する',
  permission: 'site.read',
  handler: async ({ context, params }) => {
    const site = await getSite(context, { id: params['id'] ?? '' });
    return dataResponse(toSiteResponse(site));
  },
});

export const PATCH = defineRoute({
  operationId: 'updateSite',
  method: 'PATCH',
  path: '/sites/{id}',
  summary: 'Webサイトを更新する',
  permission: 'site.write',
  body: updateSiteSchema,
  handler: async ({ context, params, body }) => {
    const site = await updateSite(context, {
      id: params['id'] ?? '',
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.url === undefined ? {} : { url: body.url }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.status === undefined ? {} : { status: body.status }),
    });
    return dataResponse(toSiteResponse(site));
  },
});

export const DELETE = defineRoute({
  operationId: 'deleteSite',
  method: 'DELETE',
  path: '/sites/{id}',
  summary: 'Webサイトを削除する',
  permission: 'site.delete',
  body: z.object({ csrfToken: z.string().optional() }),
  handler: async ({ context, params }) => {
    await deleteSite(context, { id: params['id'] ?? '' });
    return noContentResponse();
  },
});
