'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type CSSProperties } from 'react';
import { ownValue } from '@/domain/own-value';
import { parsePostSourceParam, postSourceParamOf } from '@/domain/social/post-source';
import {
  isPostStatus,
  POST_STATUSES,
  type DeliveryMode,
  type PostStatus,
} from '@/domain/social/social';
import { apiRequest } from '@/ui/client/api-client';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  FormField,
  Modal,
  Pagination,
  Select,
  Spinner,
  Table,
  Toast,
  type Column,
  type ToastMessage,
} from '@/ui/components';
import {
  bulkApproveRequestBody,
  bulkDeleteRequestBody,
  bulkPublishNowRequestBody,
  deleteBreakdownOf,
  deleteExcludedOf,
  deletePlanOf,
  effectBreakdownOf,
  excerptOf,
  excludedBreakdownOf,
  isSelectable,
  selectionState,
  sendPlanOf,
  summarizeBulkResults,
  toggleAllSelection,
  type BulkRequestFailure,
  type BulkResultItem,
  type BulkSendTiming,
} from '@/ui/social/bulk-plan';
import {
  APPROVAL_PENDING_ANCHOR,
  APPROVAL_PENDING_ROW_NOTE,
  APPROVED_ROW_NOTE,
  BULK_DELETE_CAMPAIGN_NOTE,
  BULK_DELETE_LABEL,
  BULK_DELETE_MESSAGE,
  BULK_DELETE_TITLE,
  BULK_DELETED_TOAST,
  BULK_EXCLUDED_TEXT,
  BULK_RESULT_CLOSE,
  BULK_RESULT_FAILED,
  BULK_RESULT_RETRY_HINT,
  BULK_RESULT_SUCCEEDED,
  BULK_RESULT_TITLE,
  BULK_SEND_APPROVE_LINE,
  BULK_SEND_CONFIRM,
  BULK_SEND_DESIRED_OPTION,
  BULK_SEND_LABEL,
  BULK_SEND_LEAD,
  BULK_SEND_NOTE_MANUAL_DELIVERY,
  BULK_SEND_NOTE_MANUAL_ONLY,
  BULK_SEND_NOW_OPTION,
  BULK_SEND_PUBLISH_NOW_LINE,
  BULK_SEND_TITLE,
  BULK_SEND_WARN_DESIRED_PAST,
  BULK_SEND_WARN_NO_DESIRED,
  DELIVERY_MODE_LABEL,
  MANUAL_PENDING_ANCHOR,
  MANUAL_PENDING_LABEL,
  NO_CREDENTIAL_BADGE,
  NO_PUBLISHER_BADGE,
  POST_FILTER_ACCOUNT_LABEL,
  POST_FILTER_ALL,
  POST_FILTER_CLEAR,
  POST_FILTER_EMPTY,
  POST_FILTER_PER_PAGE_LABEL,
  POST_FILTER_SOURCE_LABEL,
  POST_FILTER_STATUS_LABEL,
  POST_SOURCE_COLUMN_HEADER,
  POST_SOURCE_DELETED_SUFFIX,
  POST_SOURCE_REVOKED_SUFFIX,
  POST_SOURCE_SCREEN_LABEL,
  POST_STATUS_LABEL,
  POSTS_ANCHOR,
  remainingSkipsLabel,
  SELECT_PAGE_LABEL,
  SELECT_ROW_LABEL,
  SELECTED_COUNT,
  SELECTED_PAGE_COUNT,
} from '@/ui/social/labels';
import {
  openPostListPage,
  POST_PER_PAGE_OPTIONS,
  postListHref,
  type PostListFilters,
  type PostListOption,
  type PostSourceView,
} from '@/ui/social/post-list-params';
import { AsyncState } from '@/ui/states/async-state';

/**
 * SNS投稿一覧。
 *
 * 型A（一覧画面）の実装（`02_画面デザイン方針.md` §4）。
 * `007-sites` で確立した形をそのまま踏襲する（`01_スプリント計画.md` S7/S9）。
 *
 * **ここが表示するのは登録された投稿であって、配信の実績ではない。**
 * 外部SNSへの実配信は Plugin の責務（`01_アーキテクチャ設計.md` §12）。
 *
 * 054-bulk-post-actions で、登録元の列・絞り込みの帯・行の選択と一括操作（一括送信・一括取り消し）を足した
 * （設計 §9.1〜§9.7）。**一括選択は表示中のページの行だけ**（設計 §5.3）。絞り込みはサーバで掛け、
 * 選び直すとページ全体を読み込み直す。一括の内訳は `bulk-plan.ts` の純関数が作り、正はサーバの項目ごとの結果。
 */

export interface PostRow {
  readonly id: string;
  readonly socialAccountId: string;
  readonly body: string;
  readonly scheduledAt: string | null;
  readonly status: string;
  readonly publishedAt: string | null;
  readonly deliveryMode: DeliveryMode;
  /** 直近の失敗理由。`scheduled` のまま残っていれば再試行待ち（設計 §5.8）。 */
  readonly failureReason: string | null;
  readonly attemptCount: number;
  /**
   * 同じ理由で続けて飛ばされた回数（設計 §7.3。裁定 #15-a）。
   *
   * **`attemptCount` とは別。** あれは配信に着手した回数で、飛ばされた行では 0 のまま。
   * 予約し直しでは減らない（裁定 #14-a）ので、**運用者が予約し直す前に残りを知る**のに要る。
   */
  readonly skipCount: number;
  /** 配信後の投稿の URL。 */
  readonly externalUrl: string | null;
  /**
   * 手動投稿待ちか（設計 §7.3）。
   *
   * **「いま」は Server Component が判定する。** ここで `Date.now()` を見ると
   * Server と Client で描画が食い違う（設計 §7.1 の補足）。
   */
  readonly manualPending?: boolean;
  /**
   * 承認して予約にした時刻（ISO。048-social-post-approval 設計 §7.3）。承認を経ていなければ null。
   * **任意。** 渡さない行は承認を経ていないものとして描く。
   */
  readonly approvedAt?: string | null;
  /**
   * 一括操作の `expectedUpdatedAt`（ISO。054 設計 §9.8）。**渡さない行は選べない**
   * （チェックボックスを描かない。見た内容に対して操作する約束を守れないため）。
   */
  readonly updatedAt?: string;
  /** 登録元の表示（054 設計 §5.6）。**トークンの ID は持たない。** 渡さない行は「—」。 */
  readonly source?: PostSourceView;
  /** `scheduled` で、予約日時が未来か NULL（今すぐ送れる。「いま」は Server Component）。 */
  readonly scheduledFuture?: boolean;
  /** `scheduled`・自動配信で着手印がある（配信中）。 */
  readonly publishing?: boolean;
  /** `awaiting_approval` で、希望日時が過去（いまと等しいを含む）。 */
  readonly desiredPast?: boolean;
  /** 手動投稿のみの SNS のアカウント（承認は常に即投稿になる。048 裁定 5）。 */
  readonly manualOnly?: boolean;
}

/** アカウントごとの配信の支度（設計 §7.3）。 */
export interface AccountProvider {
  readonly provider: string;
  readonly credentialConfigured: boolean;
}

/** 登録された publisher（`publisherRegistry.listPublishers()` から Server Component が組む）。 */
export interface PublisherProvider {
  readonly label: string;
  readonly manual: boolean;
  readonly publish: boolean;
  readonly credentialFieldKeys: readonly string[];
}

/** 一括操作の結果のダイアログに渡すもの（`summarizeBulkResults` の引数と同じ形。054 実装プラン §8 の 52）。 */
export interface BulkResultsInput {
  readonly results: readonly BulkResultItem[];
  readonly requestFailures?: readonly BulkRequestFailure[];
}

/** 配信の支度ができていない理由。整っていれば null。 */
type Unready = 'no_publisher' | 'no_credential' | null;

/** 一括の応答の `data`（設計 §8.1）。 */
interface BulkResponse {
  readonly bulkId: string;
  readonly results: readonly BulkResultItem[];
}

function formatDateTime(value: string | null): string {
  if (value === null) {
    return '—';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP');
}

const CAPTION_STYLE = {
  display: 'block',
  marginTop: 'var(--tf-space-1)',
  color: 'var(--tf-color-text-muted)',
  fontSize: 'var(--tf-text-caption)',
} as const;

/** 長いトークンの名前は 1 行で省略する（全体は `title`。設計 §9.1）。 */
const ELLIPSIS_STYLE: CSSProperties = {
  display: 'block',
  maxWidth: '10rem',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/** 長い本文・文言も折る。ページ全体を横へスクロールさせない（設計 §9.11）。 */
const WRAP_ANYWHERE: CSSProperties = { overflowWrap: 'anywhere', wordBreak: 'break-word' };

/** 帯の並び。狭い画面では折り返す（設計 §9.11）。 */
const BAND_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'var(--tf-space-2) var(--tf-space-4)',
  marginBottom: 'var(--tf-space-4)',
};

export interface SocialPostsProps {
  readonly initialPosts: readonly PostRow[];
  /** アカウントIDから表示名を引くための対応表。 */
  readonly accountNames: Readonly<Record<string, string>>;
  /** アカウントIDから provider と資格情報の有無を引く対応表。 */
  readonly accountProviders: Readonly<Record<string, AccountProvider>>;
  /** provider から登録された publisher を引く対応表。 */
  readonly publisherProviders: Readonly<Record<string, PublisherProvider>>;
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly permissions: readonly string[];
  /**
   * 解釈した一覧の条件（054 設計 §9.2）。**任意。** 渡したときだけ絞り込みの帯を描く。
   * 渡さなければ条件なし（ページ送りは `page` / `perPage` を保つ）。
   */
  readonly filters?: PostListFilters;
  /** 登録元の絞り込みの選択肢（「すべて」を含む。`postSourceOptionsOf` が作る）。 */
  readonly sourceOptions?: readonly PostListOption[];
  /** アカウントの絞り込みの選択肢（「すべて」を含めない。名前順）。 */
  readonly accountOptions?: readonly PostListOption[];
  /**
   * 選んだ状態・ダイアログを開いた状態・結果のダイアログで描く（テストのための口。Server Component は渡さない）。
   * `social-accounts.tsx` の `initialEditingAccountId` と同じ形（054 設計 §9.8）。
   */
  readonly initialSelectedIds?: readonly string[];
  readonly initialDialog?: 'send' | 'delete' | null;
  readonly initialResults?: BulkResultsInput;
}

/**
 * 画面を読み込み直す（`router.refresh()`）。**描いたときに 1 回だけ呼ぶ。**
 *
 * `useRouter` は App Router の外では例外を投げるので、一覧の部品の本体では呼ばず、
 * 読み込み直すときだけこれを描く（一覧を単体で描く既存の呼び出しを壊さない）。
 */
function RefreshOnMount() {
  const router = useRouter();
  useEffect(() => {
    router.refresh();
  }, [router]);
  return null;
}

export function SocialPosts(props: SocialPostsProps) {
  /**
   * 配信の支度ができていない予約か（設計 §7.3、要件 §4 裁定 #8）。
   *
   * **予約そのものは断らない。** 弾かない代わりに、予約した時点で画面に出す。
   * 見るのは `scheduled` かつ `auto` の行だけ（手動投稿はジョブを通らない）。
   */
  function unreadyOf(post: PostRow): Unready {
    if (post.status !== 'scheduled' || post.deliveryMode !== 'auto') {
      return null;
    }
    const account = props.accountProviders[post.socialAccountId];
    if (account === undefined) {
      return null;
    }
    // provider は HTTP で決められるので、自分のプロパティだけを見る（047 設計 §4.1）。
    const publisher = ownValue(props.publisherProviders, account.provider);
    if (publisher === undefined || !publisher.publish) {
      return 'no_publisher';
    }
    // 資格情報の要らない配信手段では「未設定」を警告しない（設計 §5.7）。
    if (publisher.credentialFieldKeys.length > 0 && !account.credentialConfigured) {
      return 'no_credential';
    }
    return null;
  }

  const [posts, setPosts] = useState(props.initialPosts);
  const [deleting, setDeleting] = useState<PostRow | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  // 選択は表示中のページの行の ID の集合（設計 §5.3・§9.3）。読み込み直すと消える。
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(props.initialSelectedIds ?? []),
  );
  const [dialog, setDialog] = useState<'send' | 'delete' | null>(props.initialDialog ?? null);
  // 時機の既定は選ばない（押したときに選ぶ。ユーザー裁定 2）。
  const [sendTiming, setSendTiming] = useState<BulkSendTiming | null>(null);
  const [busy, setBusy] = useState<'send' | 'delete' | null>(null);
  const [results, setResults] = useState<BulkResultsInput | null>(props.initialResults ?? null);
  // 読み込み直した回数。増やすと `RefreshOnMount` を描き直して `router.refresh()` を呼ぶ。
  const [refreshCount, setRefreshCount] = useState(0);

  const permissions = new Set(props.permissions);
  // 表示制御であって認可ではない。サーバー側で必ず検証している（06_画面設計.md §29）。
  const canWrite = permissions.has('social.write');
  const canDelete = permissions.has('social.delete');
  const canApprove = permissions.has('social.approve');
  // 一括操作のボタンを 1 つでも出せるときだけ選択の列を描く（054 設計 §9.1・§10.1）。
  const canSelect = canApprove || canWrite || canDelete;
  const canSend = canApprove || canWrite;

  const filters: PostListFilters = props.filters ?? {
    status: null,
    accountId: null,
    source: null,
    perPage: props.perPage,
    page: props.page,
  };
  // 表示件数は「条件」に数えない（絞り込む条件ではない）。
  const hasConditions =
    filters.status !== null || filters.accountId !== null || filters.source !== null;

  const selectedRows = posts.filter((post) => selected.has(post.id));
  const pageState = selectionState(selected, posts);
  const sendPermissions = { canApprove, canWrite };
  // ボタンの disabled は即投稿の内訳で決める（「即投稿」で対象が無いなら「希望日時」でも無い。設計 §9.4）。
  const sendNowPlan = sendPlanOf(selectedRows, 'now', sendPermissions);
  const sendTargetCount = sendNowPlan.approve.length + sendNowPlan.publishNow.length;
  const deletePlan = deletePlanOf(selectedRows);

  function reload(): void {
    setSelected(new Set());
    setRefreshCount((count) => count + 1);
  }

  function toggleRow(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** 絞り込みを選び直す。1 ページ目からページ全体を読み込み直す（設計 §9.2）。 */
  function applyFilters(next: Partial<PostListFilters>): void {
    window.location.assign(postListHref({ ...filters, ...next, page: 1 }));
  }

  /**
   * 一括操作を終えたあとの表示（設計 §9.7）。
   *
   * * 要求ごと失敗し、1 件も処理していない：Toast（danger）。読み込み直さない（選択は残る）
   * * 全件成功：Toast（success）と読み込み直し
   * * それ以外：結果のダイアログ（「閉じる」で読み込み直す）
   */
  function finish(
    kind: 'send' | 'delete',
    items: readonly BulkResultItem[],
    requestFailures: readonly BulkRequestFailure[],
  ): void {
    const first = requestFailures[0];
    if (items.length === 0 && first !== undefined) {
      setToast({ id: `bulk-${kind}`, text: first.message, tone: 'danger' });
      return;
    }
    if (requestFailures.length === 0 && items.every((item) => item.ok)) {
      const summary = summarizeBulkResults(items, posts);
      setToast({
        id: `bulk-${kind}`,
        text:
          kind === 'delete'
            ? BULK_DELETED_TOAST(summary.succeeded.total)
            : BULK_RESULT_SUCCEEDED(
                summary.succeeded.total,
                effectBreakdownOf(summary.succeeded.byEffect),
              ),
        tone: 'success',
      });
      reload();
      return;
    }
    setResults({ results: items, requestFailures });
  }

  /** 1 本の一括の要求を送り、結果か要求ごとの失敗に振り分ける。 */
  async function sendBulk(
    path: string,
    body: unknown,
    ids: readonly string[],
    items: BulkResultItem[],
    requestFailures: BulkRequestFailure[],
  ): Promise<void> {
    const result = await apiRequest<BulkResponse>(path, { method: 'POST', body });
    if (result.ok) {
      items.push(...result.data.results);
    } else {
      requestFailures.push({ ids, message: result.error.message });
    }
  }

  async function submitSend(): Promise<void> {
    const timing = sendTiming;
    if (timing === null) return;
    const plan = sendPlanOf(selectedRows, timing, sendPermissions);
    setBusy('send');
    setDialog(null);
    setSendTiming(null);

    const items: BulkResultItem[] = [];
    const requestFailures: BulkRequestFailure[] = [];
    // 承認を先に、今すぐ送るを次に送る（設計 §9.5）。2 本目が要求ごと失敗しても 1 本目の結果は捨てない。
    if (plan.approve.length > 0) {
      await sendBulk(
        '/api/v1/social/posts/bulk/approve',
        bulkApproveRequestBody({ timing, rows: plan.approve }),
        plan.approve.map((row) => row.id),
        items,
        requestFailures,
      );
    }
    if (plan.publishNow.length > 0) {
      await sendBulk(
        '/api/v1/social/posts/bulk/publish-now',
        bulkPublishNowRequestBody({ rows: plan.publishNow }),
        plan.publishNow.map((row) => row.id),
        items,
        requestFailures,
      );
    }
    setBusy(null);
    finish('send', items, requestFailures);
  }

  async function submitBulkDelete(): Promise<void> {
    const targets = deletePlan.targets;
    setDialog(null);
    if (targets.length === 0) return;
    setBusy('delete');

    const items: BulkResultItem[] = [];
    const requestFailures: BulkRequestFailure[] = [];
    await sendBulk(
      '/api/v1/social/posts/bulk/delete',
      bulkDeleteRequestBody({ rows: targets }),
      targets.map((row) => row.id),
      items,
      requestFailures,
    );
    setBusy(null);
    // 消えた行は読み込み直す前に手元でも隠す（1 件の削除と同じ）。
    const deleted = new Set(items.filter((item) => item.ok).map((item) => item.id));
    if (deleted.size > 0) {
      setPosts((current) => current.filter((post) => !deleted.has(post.id)));
    }
    finish('delete', items, requestFailures);
  }

  async function confirmDelete(): Promise<void> {
    const target = deleting;
    if (target === null) return;
    setDeleting(null);

    const result = await apiRequest(`/api/v1/social/posts/${target.id}`, {
      method: 'DELETE',
      body: {},
    });

    if (result.ok) {
      setPosts((current) => current.filter((post) => post.id !== target.id));
      // 行が消えたら選択からも外す（054 設計 §9.3）。
      setSelected((current) => {
        const next = new Set(current);
        next.delete(target.id);
        return next;
      });
      setToast({ id: target.id, text: '削除しました。', tone: 'success' });
    } else {
      setToast({ id: target.id, text: result.error.message, tone: 'danger' });
    }
  }

  function sourceCell(post: PostRow) {
    const source = post.source;
    if (source === undefined) return '—';
    if (source.kind === 'screen') return POST_SOURCE_SCREEN_LABEL;
    return (
      <span>
        <span title={source.label} style={ELLIPSIS_STYLE}>
          {source.label}
        </span>
        {source.kind === 'token' && source.revoked && (
          <span style={CAPTION_STYLE}>{POST_SOURCE_REVOKED_SUFFIX}</span>
        )}
        {source.kind === 'deleted_token' && (
          <span style={CAPTION_STYLE}>{POST_SOURCE_DELETED_SUFFIX}</span>
        )}
      </span>
    );
  }

  const selectColumn: Column<PostRow> = {
    key: 'select',
    header: (
      <input
        type="checkbox"
        aria-label={SELECT_PAGE_LABEL}
        checked={pageState === 'all'}
        // `indeterminate` は DOM のプロパティなので ref で立て、描画で見られるよう印も描く（054 実装プラン §8 の 16）。
        data-indeterminate={pageState === 'some' ? 'true' : undefined}
        ref={(element) => {
          if (element !== null) element.indeterminate = pageState === 'some';
        }}
        disabled={busy !== null}
        onChange={() => setSelected(toggleAllSelection(selected, posts))}
      />
    ),
    width: '2.5rem',
    render: (post) =>
      isSelectable(post) ? (
        <input
          type="checkbox"
          aria-label={SELECT_ROW_LABEL(excerptOf(post.body))}
          checked={selected.has(post.id)}
          disabled={busy !== null}
          onChange={() => toggleRow(post.id)}
        />
      ) : null,
  };

  const columns: Column<PostRow>[] = [
    ...(canSelect ? [selectColumn] : []),
    {
      key: 'account',
      header: 'アカウント',
      width: '12rem',
      render: (post) => props.accountNames[post.socialAccountId] ?? post.socialAccountId,
    },
    {
      key: 'body',
      header: '本文',
      render: (post) => (
        <span>
          {excerptOf(post.body)}
          {/* 配信済みの投稿は外部の本物へ辿れるようにする（設計 §7.3）。 */}
          {post.status === 'published' && post.externalUrl !== null && (
            <a
              href={post.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                marginLeft: 'var(--tf-space-2)',
                color: 'var(--tf-color-primary)',
                fontSize: 'var(--tf-text-caption)',
              }}
            >
              投稿を見る ↗
            </a>
          )}
        </span>
      ),
    },
    {
      // どのアプリ（トークン）から来た投稿か（054 設計 §5.6・§9.1）。閲覧者にも出す。
      key: 'source',
      header: POST_SOURCE_COLUMN_HEADER,
      width: '10rem',
      render: sourceCell,
    },
    {
      key: 'scheduledAt',
      header: '予約日時',
      width: '12rem',
      render: (post) => formatDateTime(post.scheduledAt),
    },
    {
      key: 'deliveryMode',
      header: '配信方法',
      width: '7rem',
      render: (post) => DELIVERY_MODE_LABEL[post.deliveryMode] ?? post.deliveryMode,
    },
    {
      key: 'status',
      header: '状態',
      width: '12rem',
      render: (post) => {
        const unready = unreadyOf(post);
        return (
          <span>
            {POST_STATUS_LABEL[post.status as PostStatus] ?? post.status}
            {/*
              **再試行待ちは状態ではない**（設計 §5.8）。`scheduled` のまま失敗理由が
              残っている行がそれで、次は `attemptCount + 1` 回目になる。
            */}
            {post.status === 'scheduled' && post.failureReason !== null && (
              <span style={CAPTION_STYLE}>{`（再試行待ち・${post.attemptCount + 1} 回目）`}</span>
            )}
            {/* 承認待ちは区画で承認する（048-social-post-approval 設計 §7.3）。 */}
            {post.status === 'awaiting_approval' && (
              <span style={CAPTION_STYLE}>
                <a href={`#${APPROVAL_PENDING_ANCHOR}`}>{APPROVAL_PENDING_ROW_NOTE}</a>
              </span>
            )}
            {/* 承認を経た予約。編集すると承認待ちへ戻ることの手がかり（048 設計 §7.3）。 */}
            {post.status === 'scheduled' &&
              post.approvedAt !== undefined &&
              post.approvedAt !== null && <span style={CAPTION_STYLE}>{APPROVED_ROW_NOTE}</span>}
            {post.status === 'scheduled' && post.manualPending === true && (
              <span style={CAPTION_STYLE}>
                <a href={`#${MANUAL_PENDING_ANCHOR}`}>{MANUAL_PENDING_LABEL}</a>
              </span>
            )}
            {/*
              **残り回数は Badge とは別の問いに答える**（設計 §7.3、裁定 #15-a）。
              Badge は「支度の何が足りないか」、こちらは「あと何回で取りやめか」。
              支度が整った直後は Badge が消えても補足は残る（0 に戻るのは配信に着手できたとき）。
              飛ばされるのは `scheduled` かつ `auto` の行だけ（手動投稿はジョブを通らない）。
            */}
            {post.status === 'scheduled' && post.deliveryMode === 'auto' && post.skipCount > 0 && (
              <span style={CAPTION_STYLE}>{remainingSkipsLabel(post.skipCount)}</span>
            )}
            {unready !== null && (
              <span style={{ display: 'block', marginTop: 'var(--tf-space-1)' }}>
                <Badge tone="warning">
                  {unready === 'no_publisher' ? NO_PUBLISHER_BADGE : NO_CREDENTIAL_BADGE}
                </Badge>
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'actions',
      header: '操作',
      width: '12rem',
      render: (post) => (
        <span style={{ display: 'flex', gap: 'var(--tf-space-2)' }}>
          {canWrite && (
            <Link href={`/social/posts/${post.id}/edit`}>
              <Button variant="ghost">編集</Button>
            </Link>
          )}
          {canDelete && (
            <Button variant="ghost" onClick={() => setDeleting(post)}>
              削除
            </Button>
          )}
        </span>
      ),
    },
  ];

  const unreadyCount = posts.filter((post) => unreadyOf(post) !== null).length;

  const clearLink = <a href={`/social#${POSTS_ANCHOR}`}>{POST_FILTER_CLEAR}</a>;

  const sourceValue = filters.source === null ? '' : postSourceParamOf(filters.source);
  const sourceOptions = props.sourceOptions ?? [{ value: '', label: POST_FILTER_ALL }];

  // 一括送信のダイアログの内訳。時機を選ぶ前は即投稿の内訳を出す（設計 §9.5）。
  const sendPlan =
    sendTiming === null ? sendNowPlan : sendPlanOf(selectedRows, sendTiming, sendPermissions);
  const sendCount = sendPlan.approve.length + sendPlan.publishNow.length;
  const sendExcludedCount = sendPlan.excluded.reduce((sum, entry) => sum + entry.count, 0);
  const deleteExcluded = deleteExcludedOf(deletePlan);
  const summary =
    results === null
      ? null
      : summarizeBulkResults(results.results, posts, results.requestFailures ?? []);

  return (
    <>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          margin: 'var(--tf-space-6) 0 var(--tf-space-4)',
        }}
      >
        {/* 絞り込み・ページ送りで読み込み直した後に一覧へ戻る先（054 設計 §9.2）。 */}
        <h2 id={POSTS_ANCHOR} style={{ fontSize: '1.05rem', margin: 0 }}>
          投稿
        </h2>
        {canWrite && (
          <Link href="/social/posts/new">
            <Button variant="primary">+ 投稿を作成</Button>
          </Link>
        )}
      </header>

      {/*
        絞り込みの帯（054 設計 §9.2）。条件はサーバで掛ける。選び直すと 1 ページ目から読み込み直す。
        狭い画面では各 Select を幅いっぱいにして縦に折り返す（設計 §9.11）。
      */}
      {props.filters !== undefined && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 10rem), 1fr))',
            gap: '0 var(--tf-space-4)',
            alignItems: 'end',
          }}
        >
          <FormField label={POST_FILTER_STATUS_LABEL}>
            {(field) => (
              <Select
                {...field}
                value={filters.status ?? ''}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  applyFilters({ status: isPostStatus(value) ? value : null });
                }}
              >
                <option value="">{POST_FILTER_ALL}</option>
                {POST_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {POST_STATUS_LABEL[status]}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label={POST_FILTER_ACCOUNT_LABEL}>
            {(field) => (
              <Select
                {...field}
                value={filters.accountId ?? ''}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  applyFilters({ accountId: value === '' ? null : value });
                }}
              >
                <option value="">{POST_FILTER_ALL}</option>
                {(props.accountOptions ?? []).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label={POST_FILTER_SOURCE_LABEL}>
            {(field) => (
              <Select
                {...field}
                value={sourceValue}
                onChange={(event) =>
                  applyFilters({ source: parsePostSourceParam(event.currentTarget.value) })
                }
              >
                {sourceOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label={POST_FILTER_PER_PAGE_LABEL}>
            {(field) => (
              <Select
                {...field}
                value={String(filters.perPage)}
                onChange={(event) => applyFilters({ perPage: Number(event.currentTarget.value) })}
              >
                {POST_PER_PAGE_OPTIONS.map((option) => (
                  <option key={option} value={String(option)}>
                    {option}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          {hasConditions && <div style={{ marginBottom: 'var(--tf-space-4)' }}>{clearLink}</div>}
        </div>
      )}

      {/*
        **これは「予約を断らない」ことと対になっている**（設計 §6.1.2、要件 §4 裁定 #8）。
        このページの行の中で数える。全件を数える問い合わせは足さない。
      */}
      {unreadyCount > 0 && (
        <div style={{ marginBottom: 'var(--tf-space-4)' }}>
          <Alert tone="warning">
            {/*
              **「いつまでに直せばよいか」まで伝える**（設計 §7.3、裁定 #9）。
              支度が整わない予約は約24時間で `failed` になる。画面がそれを言わないと、
              運用者は取りやめられて初めて知ることになる。
            */}
            {`配信の支度ができていない予約投稿が ${unreadyCount} 件あります。配信 Plugin の有効化と資格情報の設定が済むまで配信されません。予約日時から約24時間が過ぎても支度が整わない投稿は、取りやめ（失敗）になります。`}
          </Alert>
        </div>
      )}

      {/*
        一括の帯（054 設計 §9.4）。**ボタンの文言に「削除」を含めない**（既存の E2E の locator と取り違えない）。
        押せるかは選んだ行の内訳で決める。正はサーバの項目ごとの結果。
      */}
      {canSelect && posts.length > 0 && (
        <div style={BAND_STYLE}>
          <span>
            {pageState === 'all' && posts.length < props.total
              ? SELECTED_PAGE_COUNT(selectedRows.length, props.total)
              : SELECTED_COUNT(selectedRows.length)}
          </span>
          {canSend && (
            <Button
              variant="secondary"
              disabled={busy !== null || sendTargetCount === 0}
              onClick={() => {
                setSendTiming(null);
                setDialog('send');
              }}
            >
              {`${BULK_SEND_LABEL}…`}
              {busy === 'send' && <Spinner />}
            </Button>
          )}
          {canDelete && (
            <Button
              variant="secondary"
              disabled={busy !== null || deletePlan.targets.length === 0}
              onClick={() => setDialog('delete')}
            >
              {`${BULK_DELETE_LABEL}…`}
              {busy === 'delete' && <Spinner />}
            </Button>
          )}
        </div>
      )}

      <AsyncState
        status={posts.length === 0 ? 'empty' : 'ready'}
        // 条件で絞って 0 件なら、登録が無いのではなく条件に合わないことを伝える（054 設計 §9.2）。
        emptyMessage={hasConditions ? POST_FILTER_EMPTY : '投稿が登録されていません。'}
        emptyAction={
          hasConditions ? (
            clearLink
          ) : canWrite ? (
            <Link href="/social/posts/new">
              <Button variant="primary">投稿を作成</Button>
            </Link>
          ) : undefined
        }
      >
        <Card>
          <Table columns={columns} rows={posts} rowKey={(post) => post.id} />
          <Pagination
            page={props.page}
            perPage={props.perPage}
            total={props.total}
            // 絞り込みを保ったまま移る（054 設計 §9.2）。選択は読み込み直しで消える。
            onChange={(page) => openPostListPage(filters, page)}
          />
        </Card>
      </AsyncState>

      <ConfirmDialog
        open={deleting !== null}
        title="投稿を削除しますか？"
        message={deleting === null ? '' : `「${excerptOf(deleting.body)}」を削除します。`}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />

      {/* 一括送信（承認）のダイアログ（054 設計 §9.5）。 */}
      <Modal
        open={dialog === 'send'}
        title={BULK_SEND_TITLE}
        onClose={() => setDialog(null)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              キャンセル
            </Button>
            <Button
              variant="primary"
              disabled={sendTiming === null || sendCount === 0 || busy !== null}
              onClick={() => void submitSend()}
            >
              {BULK_SEND_CONFIRM}
            </Button>
          </>
        }
      >
        <div style={{ display: 'grid', gap: 'var(--tf-space-3)', ...WRAP_ANYWHERE }}>
          <p style={{ margin: 0 }}>{BULK_SEND_LEAD(selectedRows.length, sendCount)}</p>
          {(['now', 'scheduled'] as const).map((timing) => (
            <label
              key={timing}
              style={{ display: 'flex', gap: 'var(--tf-space-2)', alignItems: 'center' }}
            >
              <input
                type="radio"
                name="bulkSendTiming"
                value={timing}
                checked={sendTiming === timing}
                onChange={() => setSendTiming(timing)}
              />
              {timing === 'now' ? BULK_SEND_NOW_OPTION : BULK_SEND_DESIRED_OPTION}
            </label>
          ))}
          {sendCount > 0 && (
            <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
              {sendPlan.approve.length > 0 && (
                <li>{BULK_SEND_APPROVE_LINE(sendPlan.approve.length)}</li>
              )}
              {sendPlan.publishNow.length > 0 && (
                <li>{BULK_SEND_PUBLISH_NOW_LINE(sendPlan.publishNow.length)}</li>
              )}
            </ul>
          )}
          {sendPlan.warnings.desiredPast > 0 && (
            <Alert tone="warning">
              {BULK_SEND_WARN_DESIRED_PAST(sendPlan.warnings.desiredPast)}
            </Alert>
          )}
          {sendPlan.warnings.noDesired > 0 && (
            <Alert tone="warning">{BULK_SEND_WARN_NO_DESIRED(sendPlan.warnings.noDesired)}</Alert>
          )}
          {sendPlan.warnings.manualOnly > 0 && (
            <Alert tone="info">{BULK_SEND_NOTE_MANUAL_ONLY(sendPlan.warnings.manualOnly)}</Alert>
          )}
          {sendPlan.warnings.manualDelivery > 0 && (
            <Alert tone="info">
              {BULK_SEND_NOTE_MANUAL_DELIVERY(sendPlan.warnings.manualDelivery)}
            </Alert>
          )}
          {sendExcludedCount > 0 && (
            <p style={{ margin: 0, color: 'var(--tf-color-text-muted)' }}>
              {BULK_EXCLUDED_TEXT(sendExcludedCount, excludedBreakdownOf(sendPlan.excluded))}
            </p>
          )}
        </div>
      </Modal>

      {/* 一括取り消しの確認（054 設計 §9.6）。「この操作は取り消せません。」は ConfirmDialog が出す。 */}
      <ConfirmDialog
        open={dialog === 'delete'}
        title={BULK_DELETE_TITLE}
        message={BULK_DELETE_MESSAGE(
          selectedRows.length,
          deletePlan.targets.length,
          deleteBreakdownOf(deletePlan),
        )}
        onConfirm={() => void submitBulkDelete()}
        onCancel={() => setDialog(null)}
      >
        {deleteExcluded.count > 0 && (
          <p style={{ marginBottom: 0 }}>
            {BULK_EXCLUDED_TEXT(deleteExcluded.count, deleteExcluded.breakdown)}
          </p>
        )}
        <p style={{ marginBottom: 0 }}>{BULK_DELETE_CAMPAIGN_NOTE}</p>
      </ConfirmDialog>

      {/* 一括操作の結果（054 設計 §9.7）。「閉じる」で読み込み直す。 */}
      <Modal
        open={summary !== null}
        title={BULK_RESULT_TITLE}
        onClose={() => {
          setResults(null);
          reload();
        }}
        footer={
          <Button
            variant="primary"
            onClick={() => {
              setResults(null);
              reload();
            }}
          >
            {BULK_RESULT_CLOSE}
          </Button>
        }
      >
        {summary !== null && (
          <div style={{ display: 'grid', gap: 'var(--tf-space-3)', ...WRAP_ANYWHERE }}>
            <p style={{ margin: 0 }}>
              {BULK_RESULT_SUCCEEDED(
                summary.succeeded.total,
                effectBreakdownOf(summary.succeeded.byEffect),
              )}
            </p>
            {summary.failures.length > 0 && (
              <>
                <p style={{ margin: 0 }}>{BULK_RESULT_FAILED(summary.failures.length)}</p>
                <ul style={{ margin: 0, paddingLeft: '1.2em' }}>
                  {summary.failures.map((failure) => (
                    <li key={failure.id}>
                      {`「${failure.excerpt}」 ${failure.reasonLabel}`}
                      <span style={CAPTION_STYLE}>{failure.message}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p style={{ margin: 0, color: 'var(--tf-color-text-muted)' }}>
              {BULK_RESULT_RETRY_HINT}
            </p>
          </div>
        )}
      </Modal>

      {refreshCount > 0 && <RefreshOnMount key={refreshCount} />}

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
