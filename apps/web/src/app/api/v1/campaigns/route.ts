import { createCampaign, listCampaigns } from '@/application/campaign/campaign-use-cases';
import { parseSort } from '@/api/query';
import { createdResponse, pageResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import {
  CAMPAIGN_SORT_FIELDS,
  campaignListQuerySchema,
  createCampaignSchema,
  toCampaignResponse,
} from '@/api/schemas/campaign';

const DEFAULT_SORT = [{ field: 'starts_on', direction: 'desc' as const }];

export const GET = defineRoute({
  operationId: 'listCampaigns',
  method: 'GET',
  path: '/campaigns',
  summary: 'キャンペーンの一覧を取得する',
  permission: 'campaign.read',
  query: campaignListQuerySchema,
  handler: async ({ context, query }) => {
    // 未許可の並び替えは例外になり、route.ts が 422 へ変換する。
    const sort = parseSort(query.sort, CAMPAIGN_SORT_FIELDS, DEFAULT_SORT);

    const page = await listCampaigns(context, {
      page: query.page,
      perPage: query.perPage,
      status: query.status ?? null,
      keyword: query.q ?? null,
      activeOn: query.activeOn ?? null,
      siteId: query.siteId ?? null,
      sort,
    });

    return pageResponse(page.items.map(toCampaignResponse), {
      page: query.page,
      perPage: query.perPage,
      total: page.total,
    });
  },
});

export const POST = defineRoute({
  operationId: 'createCampaign',
  method: 'POST',
  path: '/campaigns',
  summary: 'キャンペーンを作成する',
  permission: 'campaign.write',
  body: createCampaignSchema,
  handler: async ({ context, body }) => {
    const campaign = await createCampaign(context, {
      name: body.name,
      description: body.description,
      status: body.status,
      startsOn: body.startsOn,
      endsOn: body.endsOn ?? null,
      siteIds: body.siteIds,
    });
    return createdResponse(toCampaignResponse(campaign));
  },
});
