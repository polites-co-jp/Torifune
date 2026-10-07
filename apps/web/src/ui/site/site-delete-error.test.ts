import { describe, expect, it } from 'vitest';
import type { ApiFailure } from '@/ui/client/api-client';

/**
 * Web サイトの削除の失敗を Toast の文にする（053-site-scoped-social 設計 §9.3、受け入れ条件 #71）。
 *
 * Toast は削除を押した後にしか出ず、静的な描画では見られない。409 の文を選ぶ処理を純関数
 * `siteDeleteErrorText(error)`（`ui/site/site-delete-error.ts`）に出し、#71 はそれを呼ぶ
 * （実装プラン §8 の 12）。`site-list.tsx` がそれを使うことは #72 の静的検査と E2E #77 が見る。
 *
 * 未作成のモジュールなので、**指定子を `string` 型の定数に置いた動的 import** で読む（§8 の 19）。
 */

interface SiteDeleteErrorModule {
  siteDeleteErrorText(error: ApiFailure): string;
}

/** 未作成のモジュールを型検査に掛けないため、指定子は定数に置く。 */
const SITE_DELETE_ERROR_MODULE: string = '@/ui/site/site-delete-error';

async function load(): Promise<SiteDeleteErrorModule> {
  return (await import(/* @vite-ignore */ SITE_DELETE_ERROR_MODULE)) as SiteDeleteErrorModule;
}

/** サーバの 409 の文（設計 §8.6。`api/route.ts` が `details.socialAccounts` に載せる）。 */
const IN_USE_TEXT =
  'このサイトに紐づいた SNS アカウントが 1 件あります。アカウントのサイトを変えるか削除してから、サイトを削除してください。';
/** 既定の 409 の文言（`ConflictError`）。 */
const CONFLICT_MESSAGE = 'すでに使用されています。';

describe('#71 siteDeleteErrorText', () => {
  it('#71 409 で details.socialAccounts があれば、その先頭の文を返す', async () => {
    const { siteDeleteErrorText } = await load();

    expect(
      siteDeleteErrorText({
        code: 'CONFLICT',
        message: CONFLICT_MESSAGE,
        status: 409,
        details: { socialAccounts: [IN_USE_TEXT] },
      }),
    ).toBe(IN_USE_TEXT);
  });

  it('#71 409 で details.socialAccounts が複数あっても先頭の文を返す', async () => {
    const { siteDeleteErrorText } = await load();

    expect(
      siteDeleteErrorText({
        code: 'CONFLICT',
        message: CONFLICT_MESSAGE,
        status: 409,
        details: { socialAccounts: [IN_USE_TEXT, '二つ目の文'] },
      }),
    ).toBe(IN_USE_TEXT);
  });

  it('#71 409 で details が無ければ message を返す（今までどおり）', async () => {
    const { siteDeleteErrorText } = await load();

    expect(siteDeleteErrorText({ code: 'CONFLICT', message: CONFLICT_MESSAGE, status: 409 })).toBe(
      CONFLICT_MESSAGE,
    );
  });

  it('#71 409 で details に socialAccounts が無ければ message を返す', async () => {
    const { siteDeleteErrorText } = await load();

    expect(
      siteDeleteErrorText({
        code: 'CONFLICT',
        message: CONFLICT_MESSAGE,
        status: 409,
        details: { name: ['別の項目の文'] },
      }),
    ).toBe(CONFLICT_MESSAGE);
  });

  it('#71 409 で details.socialAccounts が空の配列なら message を返す', async () => {
    const { siteDeleteErrorText } = await load();

    expect(
      siteDeleteErrorText({
        code: 'CONFLICT',
        message: CONFLICT_MESSAGE,
        status: 409,
        details: { socialAccounts: [] },
      }),
    ).toBe(CONFLICT_MESSAGE);
  });

  it('#71 409 以外は details.socialAccounts があっても message を返す', async () => {
    const { siteDeleteErrorText } = await load();

    expect(
      siteDeleteErrorText({
        code: 'FORBIDDEN',
        message: '権限がありません。',
        status: 403,
        details: { socialAccounts: [IN_USE_TEXT] },
      }),
    ).toBe('権限がありません。');
  });

  it('#71 404 は message を返す', async () => {
    const { siteDeleteErrorText } = await load();

    expect(
      siteDeleteErrorText({ code: 'NOT_FOUND', message: '見つかりません。', status: 404 }),
    ).toBe('見つかりません。');
  });
});
