import { createSocialAccount, listSocialAccounts } from '@/application/social/social-use-cases';
import { createdResponse, pageResponse } from '@/api/response';
import { defineRoute } from '@/api/route';
import {
  accountEnvelopeSchema,
  accountListQuerySchema,
  accountPageSchema,
  createAccountSchema,
  toAccountResponse,
} from '@/api/schemas/social';

export const GET = defineRoute({
  operationId: 'listSocialAccounts',
  method: 'GET',
  path: '/social/accounts',
  summary: 'SNSアカウントの一覧を取得する',
  permission: 'social.read',
  query: accountListQuerySchema,
  response: accountPageSchema,
  handler: async ({ context, query }) => {
    const page = await listSocialAccounts(context, {
      page: query.page,
      perPage: query.perPage,
      provider: query.provider ?? null,
    });
    return pageResponse(page.items.map(toAccountResponse), {
      page: query.page,
      perPage: query.perPage,
      total: page.total,
    });
  },
});

export const POST = defineRoute({
  operationId: 'createSocialAccount',
  method: 'POST',
  path: '/social/accounts',
  summary: 'SNSアカウントを登録する',
  permission: 'social.write',
  body: createAccountSchema,
  response: accountEnvelopeSchema,
  successStatus: 201,
  handler: async ({ context, body }) => {
    const account = await createSocialAccount(context, {
      provider: body.provider,
      displayName: body.displayName,
      handle: body.handle,
      credential: body.credential ?? null,
      status: body.status,
    });
    return createdResponse(toAccountResponse(account));
  },
});
