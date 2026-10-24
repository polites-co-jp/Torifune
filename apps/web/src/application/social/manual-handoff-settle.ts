import { NotFoundError, ValidationError } from '@/domain/repository';
import type { ManualHandoffOutcome } from '@/application/social/social-use-cases';

/**
 * 行ごとの「投稿画面を開く」の解決を、行が変わった例外だけ結果に読み替える
 * （055-social-pending-tab 設計 §8.3・§9.12）。
 *
 * 一覧を読んでから `resolveManualHandoff` が読み直すまでに、行の配信方法が自動へ変わる
 * （`ValidationError`。その派生を含む）か、行・アカウントが消される（`NotFoundError`）と
 * UseCase は例外を投げる。行ごとの呼び出しは `Promise.all` で並ぶので、1 行の例外で
 * 送信待ちタブ全体がエラー画面になる。それを避け、その行だけを `changed` の「開けない行」にする。
 *
 * **それ以外の例外はそのまま投げ直す**（認可の失敗・DB の障害を「開けない行」に隠さない）。
 * 結果（`ok: true` / 既存の理由の `ok: false`）はそのまま返す。
 */
export async function settleManualHandoff(
  pending: Promise<ManualHandoffOutcome>,
): Promise<ManualHandoffOutcome> {
  try {
    return await pending;
  } catch (error) {
    if (error instanceof ValidationError || error instanceof NotFoundError) {
      return { ok: false, reason: 'changed' };
    }
    throw error;
  }
}
