import { toPublicUser } from '@/authentication/identity';
import { requireAuthenticated } from '@/application/authorization/authorize';
import { defineRoute } from '@/api/route';
import { dataResponse } from '@/api/response';

export const GET = defineRoute({
  operationId: 'getCurrentUser',
  method: 'GET',
  path: '/auth/me',
  summary: '現在ログインしているユーザーを取得する',
  permission: null,
  reason: '認証状態そのものを返す処理。未認証なら 401 を返す',
  handler: async ({ context }) => {
    const identity = requireAuthenticated(context);

    // permissions は **UI の表示制御のため**に返す。
    // 認可はサーバー側で行っており、この配列を書き換えても判定は変わらない
    // （06_画面設計.md §29）。
    return dataResponse({
      ...toPublicUser(identity),
      permissions: [...context.permissions].sort(),
    });
  },
});
