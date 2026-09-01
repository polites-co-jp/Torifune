import { z } from 'zod';
import {
  deleteCampaign,
  getCampaign,
  updateCampaign,
} from '@/application/campaign/campaign-use-cases';
import { dataResponse, noContentResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import {
  campaignEnvelopeSchema,
  toCampaignResponse,
  updateCampaignSchema,
} from '@/api/schemas/campaign';

export const GET = defineRoute({
  operationId: 'getCampaign',
  method: 'GET',
  path: '/campaigns/{id}',
  summary: 'キャンペーンを取得する',
  permission: 'campaign.read',
  response: campaignEnvelopeSchema,
  handler: async ({ context, params }) => {
    const campaign = await getCampaign(context, { id: params['id'] ?? '' });
    return dataResponse(toCampaignResponse(campaign));
  },
});

export const PATCH = defineRoute({
  operationId: 'updateCampaign',
  method: 'PATCH',
  path: '/campaigns/{id}',
  summary: 'キャンペーンを更新する',
  permission: 'campaign.write',
  body: updateCampaignSchema,
  response: campaignEnvelopeSchema,
  handler: async ({ context, params, body }) => {
    const campaign = await updateCampaign(context, {
      id: params['id'] ?? '',
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.startsOn === undefined ? {} : { startsOn: body.startsOn }),
      // null は「終わりを決めない」を意味する。undefined（変えない）と区別する。
      ...(body.endsOn === undefined ? {} : { endsOn: body.endsOn }),
      ...(body.siteIds === undefined ? {} : { siteIds: body.siteIds }),
      ...(body.socialPostIds === undefined ? {} : { socialPostIds: body.socialPostIds }),
    });
    return dataResponse(toCampaignResponse(campaign));
  },
});

export const DELETE = defineRoute({
  operationId: 'deleteCampaign',
  method: 'DELETE',
  path: '/campaigns/{id}',
  summary: 'キャンペーンを削除する',
  permission: 'campaign.delete',
  body: z.object({ csrfToken: z.string().optional() }),
  successStatus: 204,
  handler: async ({ context, params }) => {
    await deleteCampaign(context, { id: params['id'] ?? '' });
    return noContentResponse();
  },
});
