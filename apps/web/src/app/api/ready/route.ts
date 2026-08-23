import { getDatabaseProvider } from '@/database/registry';

/** データベースへ到達できるかを、例外を投げずに判定する。 */
async function checkDatabase(): Promise<boolean> {
  try {
    return await getDatabaseProvider().healthCheck();
  } catch {
    // DATABASE_URL 未設定など。理由は返さない（構成情報を外へ出さない）。
    return false;
  }
}

/**
 * Readiness: リクエストを受けられる状態か。データベースへの到達性を確認する。
 *
 * Liveness（/api/health）と分けているのは、DB が落ちているときに
 * コンテナを再起動しても意味がないため。再起動ではなく、ルーティングから外すのが正しい。
 */
export async function GET() {
  const database = await checkDatabase();

  return Response.json(
    { status: database ? 'ready' : 'not_ready', checks: { database } },
    { status: database ? 200 : 503 },
  );
}
