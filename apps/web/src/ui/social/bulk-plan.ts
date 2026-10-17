import {
  BULK_DELETABLE_STATUSES,
  type BulkEffect,
  type BulkFailureReason,
} from '@/domain/social/bulk';
import type { DeliveryMode, PostStatus } from '@/domain/social/social';
import {
  BULK_EFFECT_LABEL,
  BULK_EXCLUDED_LABEL,
  BULK_REASON_LABEL,
  BULK_REQUEST_FAILED_LABEL,
  POST_STATUS_LABEL,
  type BulkExcludedReason,
} from './labels';

/**
 * 投稿一覧の選択と一括操作の純関数（054-bulk-post-actions 設計 §9.3〜§9.7、実装プラン §8 の 17）。
 *
 * 一括送信・一括取り消しのダイアログの内訳、要求の本文、結果の要約を作る。**`'use client'` にしない**
 * （単体テストで押せない操作をここで見る。実装プラン §8 の 16）。
 *
 * 内訳は**画面が読んだ行**から作る見込みであって、正はサーバの項目ごとの結果。
 * 「いま」は見ない。期限が来ているか・配信中か・希望日時が過ぎているかは Server Component が決めて行に載せる。
 */

/** 計画に使う行の項目（`PostRow` と設計 §9.8 の任意の項目）。 */
export interface BulkPlanRow {
  readonly id: string;
  readonly body: string;
  readonly status: string;
  readonly deliveryMode: DeliveryMode;
  readonly scheduledAt: string | null;
  readonly approvedAt?: string | null;
  /** 一括の `expectedUpdatedAt`。**無い行は選べない**（実装プラン §8 の 17）。 */
  readonly updatedAt?: string;
  readonly scheduledFuture?: boolean;
  readonly publishing?: boolean;
  readonly desiredPast?: boolean;
  readonly manualOnly?: boolean;
}

/** 一括送信の時機（ユーザー裁定 2）。 */
export type BulkSendTiming = 'now' | 'scheduled';

export type SelectionState = 'none' | 'some' | 'all';

export interface BulkExcludedCount {
  readonly reason: BulkExcludedReason;
  readonly count: number;
}

export interface BulkSendPlan<R extends BulkPlanRow> {
  /** `bulk/approve` へ送る行。 */
  readonly approve: readonly R[];
  /** `bulk/publish-now` へ送る行（即投稿のときだけ）。 */
  readonly publishNow: readonly R[];
  /** 対象外の理由ごとの件数（0 件の理由は含めない）。 */
  readonly excluded: readonly BulkExcludedCount[];
  readonly warnings: {
    /** 希望日時で承認する行のうち、希望日時を過ぎているもの。 */
    readonly desiredPast: number;
    /** 希望日時で承認する行のうち、希望日時が無いもの。 */
    readonly noDesired: number;
    /** 承認する行のうち、手動投稿のみの SNS のもの（常に即投稿）。 */
    readonly manualOnly: number;
    /** 今すぐ送る行のうち、手動投稿（「手動投稿待ち」に並ぶ）。 */
    readonly manualDelivery: number;
  };
}

export interface BulkDeletePlan<R extends BulkPlanRow> {
  readonly targets: readonly R[];
  readonly byStatus: {
    readonly draft: number;
    readonly awaiting_approval: number;
    readonly scheduled: number;
  };
  readonly excluded: {
    readonly published: number;
    readonly failed: number;
    readonly publishing: number;
  };
}

/** 応答の `results` の要素（設計 §8.1。`post` は応答の形の投稿で、ここでは使わない）。 */
export type BulkResultItem =
  | { readonly id: string; readonly ok: true; readonly effect: BulkEffect; readonly post: unknown }
  | {
      readonly id: string;
      readonly ok: false;
      readonly reason: BulkFailureReason;
      readonly message: string;
      readonly field: string | null;
    };

/** 要求そのものが失敗した（401・403・422・429・500・通信の失敗）ときの、その要求の項目。 */
export interface BulkRequestFailure {
  readonly ids: readonly string[];
  readonly message: string;
}

export interface BulkFailureSummary {
  readonly id: string;
  readonly excerpt: string;
  readonly reasonLabel: string;
  readonly message: string;
}

export interface BulkResultSummary {
  readonly succeeded: {
    readonly total: number;
    readonly byEffect: Readonly<Partial<Record<BulkEffect, number>>>;
  };
  readonly failures: readonly BulkFailureSummary[];
}

/** 一覧に本文を全部出すと表が崩れる。1 行に収まる長さで切る。 */
const EXCERPT_LENGTH = 60;

/** 本文の抜粋（一覧の行・チェックボックスの名前・結果の一覧で同じ切り方にする）。 */
export function excerptOf(body: string): string {
  const oneLine = body.replace(/\s+/g, ' ').trim();
  return oneLine.length <= EXCERPT_LENGTH ? oneLine : `${oneLine.slice(0, EXCERPT_LENGTH)}…`;
}

/** 選べる行か。`expectedUpdatedAt` を作れない行（`updatedAt` が無い）は選ばない。 */
export function isSelectable(row: BulkPlanRow): boolean {
  return row.updatedAt !== undefined;
}

/** 見出しのチェックボックスの状態（設計 §9.3）。選べる行だけで数える。 */
export function selectionState(
  selected: ReadonlySet<string>,
  rows: readonly BulkPlanRow[],
): SelectionState {
  const selectable = rows.filter(isSelectable);
  const count = selectable.filter((row) => selected.has(row.id)).length;
  if (count === 0) return 'none';
  return count === selectable.length ? 'all' : 'some';
}

/** 見出しのチェックボックスを押したとき。全行を選んでいれば全部外し、そうでなければ表示中の全行を選ぶ。 */
export function toggleAllSelection(
  selected: ReadonlySet<string>,
  rows: readonly BulkPlanRow[],
): ReadonlySet<string> {
  if (selectionState(selected, rows) === 'all') {
    return new Set();
  }
  return new Set(rows.filter(isSelectable).map((row) => row.id));
}

/** 対象外の件数を数える。並びは `BULK_EXCLUDED_LABEL` の順。 */
function countExcluded(reasons: readonly BulkExcludedReason[]): BulkExcludedCount[] {
  return (Object.keys(BULK_EXCLUDED_LABEL) as BulkExcludedReason[])
    .map((reason) => ({ reason, count: reasons.filter((value) => value === reason).length }))
    .filter((entry) => entry.count > 0);
}

/** 行が状態の名前で対象外になるときの理由（下書き・配信済み・失敗）。 */
function statusExclusion(status: string): BulkExcludedReason | null {
  return status === 'draft' || status === 'published' || status === 'failed' ? status : null;
}

/**
 * 一括送信の内訳（設計 §9.5 の表）。
 *
 * * 承認待ち：`canApprove` なら承認、無ければ対象外（承認の権限なし）
 * * 予約済み・未来：即投稿なら今すぐ送る（承認済みの予約は `canApprove` も要る。設計 §5.4）、希望日時なら対象外（変更なし）
 * * 予約済み・期限が来ている／配信中：対象外
 * * 下書き・配信済み・失敗：状態の名前ごとに対象外
 */
export function sendPlanOf<R extends BulkPlanRow>(
  rows: readonly R[],
  timing: BulkSendTiming,
  permissions: { readonly canApprove: boolean; readonly canWrite: boolean },
): BulkSendPlan<R> {
  const approve: R[] = [];
  const publishNow: R[] = [];
  const excluded: BulkExcludedReason[] = [];

  for (const row of rows) {
    if (row.status === 'awaiting_approval') {
      if (permissions.canApprove) approve.push(row);
      else excluded.push('no_permission');
      continue;
    }
    if (row.status === 'scheduled') {
      if (row.publishing === true || row.scheduledFuture !== true) {
        excluded.push('due_or_publishing');
      } else if (timing === 'scheduled') {
        excluded.push('scheduled_unchanged');
      } else {
        const approved = row.approvedAt !== undefined && row.approvedAt !== null;
        const allowed = permissions.canWrite && (!approved || permissions.canApprove);
        if (allowed) publishNow.push(row);
        else excluded.push('no_permission');
      }
      continue;
    }
    const reason = statusExclusion(row.status);
    if (reason !== null) excluded.push(reason);
  }

  // 手動投稿のみの SNS の承認は時機によらず即投稿になる（048 裁定 5）ので、希望日時の警告に数えない。
  const desiredTargets =
    timing === 'scheduled' ? approve.filter((row) => row.manualOnly !== true) : [];
  return {
    approve,
    publishNow,
    excluded: countExcluded(excluded),
    warnings: {
      desiredPast: desiredTargets.filter(
        (row) => row.scheduledAt !== null && row.desiredPast === true,
      ).length,
      noDesired: desiredTargets.filter((row) => row.scheduledAt === null).length,
      manualOnly: approve.filter((row) => row.manualOnly === true).length,
      manualDelivery: publishNow.filter((row) => row.deliveryMode === 'manual').length,
    },
  };
}

/**
 * 一括取り消しの内訳（設計 §9.6）。
 *
 * 対象は Domain の `BULK_DELETABLE_STATUSES`（下書き・承認待ち・予約済み）で、配信中でない行。
 * 配信済み・失敗・配信中は対象外として数える。
 */
export function deletePlanOf<R extends BulkPlanRow>(rows: readonly R[]): BulkDeletePlan<R> {
  const deletable: readonly string[] = BULK_DELETABLE_STATUSES;
  const targets = rows.filter((row) => deletable.includes(row.status) && row.publishing !== true);
  const countStatus = (status: PostStatus): number =>
    targets.filter((row) => row.status === status).length;
  return {
    targets,
    byStatus: {
      draft: countStatus('draft'),
      awaiting_approval: countStatus('awaiting_approval'),
      scheduled: countStatus('scheduled'),
    },
    excluded: {
      published: rows.filter((row) => row.status === 'published').length,
      failed: rows.filter((row) => row.status === 'failed').length,
      publishing: rows.filter((row) => row.status === 'scheduled' && row.publishing === true)
        .length,
    },
  };
}

function itemsOf(rows: readonly BulkPlanRow[]): { id: string; expectedUpdatedAt: string }[] {
  // 画面が読んだ `updatedAt` を添える（見た内容に対して操作する。設計 §5.3）。
  return rows.map((row) => ({ id: row.id, expectedUpdatedAt: row.updatedAt ?? '' }));
}

/** `POST /social/posts/bulk/approve` の本文。**`scheduledAt` を含めない**（ユーザー裁定 2）。 */
export function bulkApproveRequestBody(input: {
  readonly timing: BulkSendTiming;
  readonly rows: readonly BulkPlanRow[];
}): { publishTiming: BulkSendTiming; items: { id: string; expectedUpdatedAt: string }[] } {
  return { publishTiming: input.timing, items: itemsOf(input.rows) };
}

/** `POST /social/posts/bulk/publish-now` の本文。 */
export function bulkPublishNowRequestBody(input: { readonly rows: readonly BulkPlanRow[] }): {
  items: { id: string; expectedUpdatedAt: string }[];
} {
  return { items: itemsOf(input.rows) };
}

/** `POST /social/posts/bulk/delete` の本文（`expectedUpdatedAt` を取らない。設計 §5.5）。 */
export function bulkDeleteRequestBody(input: { readonly rows: readonly BulkPlanRow[] }): {
  ids: string[];
} {
  return { ids: input.rows.map((row) => row.id) };
}

/**
 * 一括操作の結果の要約（設計 §9.7）。
 *
 * 失敗の一覧は結果の順、続けて要求ごとの失敗の項目（`requestFailures` の順）。
 * 1 本目の結果は、2 本目の要求が失敗しても捨てない（設計 §9.5）。
 */
export function summarizeBulkResults(
  results: readonly BulkResultItem[],
  rows: readonly BulkPlanRow[],
  requestFailures: readonly BulkRequestFailure[] = [],
): BulkResultSummary {
  const bodies = new Map(rows.map((row) => [row.id, row.body]));
  const excerptFor = (id: string): string => {
    const body = bodies.get(id);
    return body === undefined ? id : excerptOf(body);
  };

  const byEffect: Partial<Record<BulkEffect, number>> = {};
  let total = 0;
  const failures: BulkFailureSummary[] = [];
  for (const item of results) {
    if (item.ok) {
      total += 1;
      byEffect[item.effect] = (byEffect[item.effect] ?? 0) + 1;
    } else {
      failures.push({
        id: item.id,
        excerpt: excerptFor(item.id),
        reasonLabel: BULK_REASON_LABEL[item.reason],
        message: item.message,
      });
    }
  }
  for (const failure of requestFailures) {
    for (const id of failure.ids) {
      failures.push({
        id,
        excerpt: excerptFor(id),
        reasonLabel: BULK_REQUEST_FAILED_LABEL,
        message: failure.message,
      });
    }
  }
  return { succeeded: { total, byEffect }, failures };
}

/** 成功の効果ごとの内訳の文（例「承認 4・今すぐ送る 2」）。同じ表示名は足し合わせる。 */
export function effectBreakdownOf(byEffect: Readonly<Partial<Record<BulkEffect, number>>>): string {
  const counts = new Map<string, number>();
  for (const [effect, count] of Object.entries(byEffect) as [BulkEffect, number][]) {
    if (count > 0) {
      const label = BULK_EFFECT_LABEL[effect];
      counts.set(label, (counts.get(label) ?? 0) + count);
    }
  }
  return [...counts].map(([label, count]) => `${label} ${count}`).join('・');
}

/** 一括送信の対象外の内訳の文（例「配信済み 1・配信待ち・配信中 1」）。 */
export function excludedBreakdownOf(excluded: readonly BulkExcludedCount[]): string {
  return excluded.map((entry) => `${BULK_EXCLUDED_LABEL[entry.reason]} ${entry.count}`).join('・');
}

/** 一括取り消しの状態ごとの内訳の文（例「下書き 1・承認待ち 2・予約済み 1」）。 */
export function deleteBreakdownOf(plan: BulkDeletePlan<BulkPlanRow>): string {
  return (['draft', 'awaiting_approval', 'scheduled'] as const)
    .filter((status) => plan.byStatus[status] > 0)
    .map((status) => `${POST_STATUS_LABEL[status]} ${plan.byStatus[status]}`)
    .join('・');
}

/** 一括取り消しの対象外の件数と内訳（例「配信済み 1・失敗 1」）。 */
export function deleteExcludedOf(plan: BulkDeletePlan<BulkPlanRow>): {
  readonly count: number;
  readonly breakdown: string;
} {
  const entries = [
    [POST_STATUS_LABEL.published, plan.excluded.published],
    [POST_STATUS_LABEL.failed, plan.excluded.failed],
    [BULK_EXCLUDED_LABEL.publishing, plan.excluded.publishing],
  ] as const;
  return {
    count: entries.reduce((sum, [, count]) => sum + count, 0),
    breakdown: entries
      .filter(([, count]) => count > 0)
      .map(([label, count]) => `${label} ${count}`)
      .join('・'),
  };
}
