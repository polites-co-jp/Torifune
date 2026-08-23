/**
 * Liveness 用のヘルスチェック。
 * DB 等の依存を確認する Readiness は Database Provider 導入後（001-database-foundation）に追加する。
 */
export function GET() {
  return Response.json({ status: 'ok' });
}
