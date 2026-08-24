/**
 * Liveness: プロセスが生きているか。依存を確認しない。
 * 落ちていたらコンテナを再起動するべき、という判断に使う。
 */
export function GET() {
  return Response.json({ status: 'ok' });
}
