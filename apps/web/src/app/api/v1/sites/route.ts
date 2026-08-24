import { createSite, listSites } from '@/application/site/site-use-cases';
import { parseSort } from '@/api/query';
import { createdResponse, pageResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import {
  createSiteSchema,
  SITE_SORT_FIELDS,
  siteListQuerySchema,
  toSiteResponse,
} from '@/api/schemas/site';

const DEFAULT_SORT = [{ field: 'created_at', direction: 'desc' as const }];

export const GET = defineRoute({
  operationId: 'listSites',
  method: 'GET',
  path: '/sites',
  summary: 'Webサイトの一覧を取得する',
  permission: 'site.read',
  query: siteListQuerySchema,
  handler: async ({ context, query }) => {
    // 未許可の並び替えは例外になり、route.ts が 422 へ変換する。
    const sort = parseSort(query.sort, SITE_SORT_FIELDS, DEFAULT_SORT);

    const page = await listSites(context, {
      page: query.page,
      perPage: query.perPage,
      status: query.status ?? null,
      keyword: query.q ?? null,
      sort,
    });

    return pageResponse(page.items.map(toSiteResponse), {
      page: query.page,
      perPage: query.perPage,
      total: page.total,
    });
  },
});

export const POST = defineRoute({
  operationId: 'createSite',
  method: 'POST',
  path: '/sites',
  summary: 'Webサイトを作成する',
  permission: 'site.write',
  body: createSiteSchema,
  handler: async ({ context, body }) => {
    const site = await createSite(context, {
      name: body.name,
      url: body.url,
      description: body.description,
      status: body.status,
    });
    return createdResponse(toSiteResponse(site));
  },
});
