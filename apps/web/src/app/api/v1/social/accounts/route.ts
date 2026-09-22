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
import { ensurePluginsStartedAnonymously } from '@/plugin/runtime';

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
    // `credentials` の突き合わせが publisher の登録簿を引く（設計 §6.7）。
    await ensurePluginsStartedAnonymously();

    const account = await createSocialAccount(context, {
      provider: body.provider,
      displayName: body.displayName,
      handle: body.handle,
      credential: body.credential ?? null,
      ...(body.credentials === undefined ? {} : { credentials: body.credentials }),
      status: body.status,
    });
    return createdResponse(toAccountResponse(account));
  },
});
