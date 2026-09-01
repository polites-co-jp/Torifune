import { auditRepository, type RecentActivity } from '../infrastructure/audit-repository';
import { defineUseCase } from './authorization/use-case';

/**
 * 監査ログの参照（05_API設計.md §42）。
 *
 * **記録側（`audit.ts`）と別のファイルにしている。**
 * `defineUseCase` は記録側を呼ぶ。そのため記録側に `defineUseCase` を使う
 * UseCase を置くと import が循環し、`registry` が初期化される前に触って
 * 実行時に落ちる。参照系はここへ置く。
 */

/**
 * 直近の操作を返す（ダッシュボードの「最近の活動」）。
 *
 * **`system.manage` を要求する。** 監査ログは「誰が何を消したか」まで含む。
 * ログインしていれば誰でも読める状態にすると、閲覧権限しか持たない利用者へ
 * 管理者の操作が筒抜けになる。画面側もこの権限が無ければ Widget を出さない。
 */
export const listRecentActivities = defineUseCase<
  { readonly limit: number },
  readonly RecentActivity[]
>({
  name: 'audit.listRecent',
  permission: 'system.manage',
  handler: async (context, input) => {
    // 上限を固定する。画面から大きな値を渡させない。
    const limit = Math.min(Math.max(input.limit, 1), 50);
    return auditRepository.listRecent(context.connection, limit);
  },
});
