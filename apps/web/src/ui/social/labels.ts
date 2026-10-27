/**
 * SNS画面の表示文言。
 *
 * **コンポーネントの中に直書きしない**（`02_画面デザイン方針.md` §5）。
 * 一覧とフォームで同じ状態に別の言い方をすると、同じものだと分からなくなる。
 * 国際化はこの計画ではやらないが、差し替える場所を1つにはしておく。
 */

import type { BulkEffect, BulkFailureReason } from '@/domain/social/bulk';
import type { PendingKind, PendingSort } from '@/domain/social/pending';
import { PUBLISH_MAX_SKIPS } from '@/domain/social/publishing';
import type { AccountStatus, DeliveryMode, PostStatus } from '@/domain/social/social';
import type { SocialTabKey } from './social-tabs';

export const POST_STATUS_LABEL: Record<PostStatus, string> = {
  draft: '下書き',
  awaiting_approval: '承認待ち',
  scheduled: '予約済み',
  published: '配信済み',
  failed: '失敗',
};

export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  connected: '接続済み',
  disconnected: '未接続',
  error: 'エラー',
};

/** 配信方法（035-social-publishing 設計 §7.3）。 */
export const DELIVERY_MODE_LABEL: Record<DeliveryMode, string> = {
  auto: '自動',
  manual: '手動',
};

// ---------------------------------------------------------------------------
// 手動投稿待ち（035-social-publishing 設計 §7.1）
// ---------------------------------------------------------------------------

export const MANUAL_PENDING_LABEL = '手動投稿待ち';

export const MANUAL_PENDING_OPEN_LABEL = '投稿画面を開く';
export const MANUAL_PENDING_FALLBACK_LABEL = '別のタブで開く';
export const MANUAL_PENDING_DONE_LABEL = '投稿した';
export const MANUAL_PENDING_CANCEL_LABEL = '取りやめ';

export const MANUAL_PENDING_GUIDE =
  '予約時刻を過ぎた手動投稿です。「投稿画面を開く」で投稿内容が入った画面が開きます。投稿し終えたら「投稿した」を押してください。';

/**
 * 投稿画面を開けない理由（設計 §7.1）。
 *
 * **Plugin の例外の中身は出さない。** 運用者が原因へ辿る経路はログにある。
 */
export const MANUAL_HANDOFF_REASON_LABEL = {
  unsupported: 'この SNS の Plugin が無効です',
  invalid_url: 'Plugin が返した URL を開けません',
  plugin_error: 'Plugin でエラーが起きました',
  // 予約でない手動投稿（承認待ちなど）には投稿画面の URL を作らない（055-social-pending-tab 設計 §8.3）。
  not_scheduled: '承認すると投稿画面を開けます',
  // 描画の途中で行が自動へ変わった・消された（055-social-pending-tab 設計 §8.3。`settleManualHandoff` が読み替える）。
  changed: '投稿が変わりました。読み込み直してください',
} as const satisfies Record<string, string>;

// ---------------------------------------------------------------------------
// 承認待ち（048-social-post-approval 設計 §7.1〜§7.6）
// ---------------------------------------------------------------------------

export const APPROVAL_PENDING_LABEL = '承認待ち';

export const APPROVAL_PENDING_GUIDE =
  '外部アプリなどから確認を求められている投稿です。内容を確かめて「承認する」を押すと配信に回ります。「差し戻す」と下書きに戻ります。';

/** 区画の行の「承認する…」（ダイアログを開く）。ダイアログの確定ボタンは `APPROVE_LABEL`。 */
export const APPROVE_OPEN_LABEL = '承認する…';
export const APPROVE_LABEL = '承認する';
export const REJECT_LABEL = '差し戻す';
export const APPROVE_DIALOG_TITLE = '投稿を承認する';
export const APPROVE_NOW_LABEL = '即投稿（次の定期実行で配信に回ります）';
export const APPROVE_SCHEDULED_LABEL = '指定の時間に投稿';
export const APPROVE_DESIRED_PAST_WARNING =
  '希望日時を過ぎています。即投稿を選ぶか、日時を指定し直してください。';
/** 手動投稿しかできない配信 Plugin の行の注意（設計 §6.7.3・§7.1.3）。 */
export const MANUAL_ONLY_APPROVAL_NOTE =
  'この SNS は手動投稿のみのため、承認するとすぐ「手動投稿待ち」に並びます。';
/** 承認の 409（見た後に内容が変わった。設計 §7.1.3）。 */
export const APPROVE_STALE_MESSAGE =
  '投稿の内容が変わっています。内容を確かめてから承認し直してください。';
export const APPROVE_RELOAD_LABEL = '閉じて読み込み直す';
export const APPROVED_TOAST_AUTO = '承認しました。配信に回ります。';
export const APPROVED_TOAST_MANUAL = '承認しました。「手動投稿待ち」から投稿してください。';
export const REJECT_CONFIRM_TITLE = '承認の依頼を差し戻しますか？';
export const REJECT_CONFIRM_MESSAGE = '下書きに戻します。承認の依頼は取り下げられます。';
export const REJECTED_TOAST = '差し戻し、下書きに戻しました。';

/** 行の上段の見出し（設計 §7.1.2）。 */
export const APPROVAL_REQUESTED_LABEL = '依頼';
export const APPROVAL_DESIRED_LABEL = '希望日時';
/** 依頼の経路。API トークンからの登録か、画面からの登録か。 */
export const APPROVAL_VIA_LABEL = { api: 'API', screen: '画面' } as const;
export const APPROVAL_DESIRED_PAST_NOTE = '（過ぎています）';
export const APPROVAL_LINK_LABEL = 'リンク';
export const APPROVAL_MEDIA_LABEL = '画像';

/**
 * 投稿一覧の状態列の補足（設計 §7.3）。承認は送信待ちタブで行う
 * （055-social-pending-tab 設計 §9.8。リンク先は `PENDING_APPROVAL_HREF`）。
 */
export const APPROVAL_PENDING_ROW_NOTE = '（送信待ちで承認）';
export const APPROVED_ROW_NOTE = '（承認済み）';

/** 投稿フォームの案内（設計 §7.4）。 */
export const POST_FORM_AWAITING_NOTE =
  '承認待ちの投稿です。予約にするには SNS 画面の「承認待ち」で承認してください。';
export const POST_FORM_APPROVED_NOTE =
  '承認済みの投稿です。本文・リンク・画像・日時・配信方法を変えると承認待ちに戻ります。';

/** ダッシュボードの案内（設計 §7.5）。件数は呼ぶ側が整えて渡す。 */
export function APPROVAL_REMINDER(count: string): string {
  return `承認待ちの投稿が ${count} 件あります。SNS 画面で確かめてください。`;
}

/** 配信の支度ができていない予約への注意（設計 §7.3、要件 §4 裁定 #8）。 */
export const NO_PUBLISHER_BADGE = '配信 Plugin なし';
export const NO_CREDENTIAL_BADGE = '資格情報 未設定';

/**
 * 飛ばされた予約に残っている回数（設計 §7.3。裁定 #15-a）。
 *
 * 裁定 #14-a（予約し直しでは飛ばされた回数が減らない）の代償で、
 * **2 回飛ばされた投稿は日時を直しても次の 1 回で `failed`** になる（設計 §11 #24）。
 * `failed` は終端なので予約へ戻せない。**運用者が予約し直す前に残りを知れるようにする。**
 *
 * `Badge`（「配信 Plugin なし」「資格情報 未設定」）が答えるのは「支度の何が足りないか」で、
 * こちらが答えるのは「あと何回で取りやめか」。**別の問いなので別に出す。**
 * 上限は画面に直書きせず `PUBLISH_MAX_SKIPS` から引く。
 */
export function remainingSkipsLabel(skipCount: number): string {
  const remaining = Math.max(0, PUBLISH_MAX_SKIPS - skipCount);
  return `（支度待ち・あと ${remaining} 回で取りやめ）`;
}

/**
 * 再試行待ちの補足（設計 §5.8）。**再試行待ちは状態ではない。** `scheduled` のまま失敗理由が残っている行がそれで、
 * 次は `attemptCount + 1` 回目になる。投稿タブと送信待ちタブの状態の列で使う。
 */
export function retryingNoteLabel(attemptCount: number): string {
  return `（再試行待ち・${attemptCount + 1} 回目）`;
}

/**
 * 投稿フォームの配信の説明（設計 §7.4）。
 *
 * **前半は変えない。** 「実際の配信は、連携プラグインが行います」は E2E が見ている。
 */
export const POST_FORM_DELIVERY_NOTE =
  'ここで登録するのは投稿の内容と予定です。実際の配信は、連携プラグインが行います。自動配信は予約日時に Torifune が行い、手動投稿は予約日時を過ぎると「手動投稿待ち」に並びます。';

/**
 * 予約日時の欄の案内（設計 §11 #21。裁定 #12-a の代償）。
 *
 * 配信の支度が整わず後ろへ送られた投稿は、**予約日時を未来へ動かしたときだけ**
 * 待ち時刻が消える。過去の日時のまま保存しても消えないので、最大 23 時間待たされる。
 * **日時を直している人の目に入る場所で案内する。**
 */
export const POST_FORM_SCHEDULE_NOTE =
  '空欄なら予約しません。いますぐ出したいときは、過去の日時ではなく数分後の日時を指定してください。';

// ---------------------------------------------------------------------------
// 資格情報の欄の出し分けと入れ直し（039-social-credential-fields 設計 §7.2〜§7.4、§7.8）
// ---------------------------------------------------------------------------

/** publisher が無い provider の汎用の欄（035-social-publishing 設計 §7.5）。 */
export const CREDENTIAL_GENERIC_FIELD_LABEL = '資格情報（アクセストークン等）';

/** 行のボタンと、入れ直しの Modal のタイトル。 */
export const CREDENTIAL_SET_LABEL = '資格情報を設定';

export const CREDENTIAL_STATE_CONFIGURED = '現在の状態：設定済み';
export const CREDENTIAL_STATE_NOT_CONFIGURED = '現在の状態：未設定';

export const CREDENTIAL_CLEAR_LABEL = '資格情報を消す';
export const CREDENTIAL_CLEAR_CONFIRM_TITLE = '資格情報を消しますか？';
export const CREDENTIAL_CLEAR_CONFIRM_LABEL = '消す';

export const CREDENTIAL_SAVED = '資格情報を保存しました。';
export const CREDENTIAL_CLEARED = '資格情報を消しました。';

/** 入れ直しの画面での確かめ（設計 §7.3.3 の 1）。正はサーバ。 */
export const CREDENTIAL_ALL_FIELDS_REQUIRED = 'すべての項目を入力してください。';
export const CREDENTIAL_REQUIRED = '資格情報を入力してください。';

/**
 * publisher が資格情報を使わない（`credentialFields: []`）provider の説明（設計 §7.2 / §7.3.2）。
 *
 * `setCredentialBody('none', …)` の `message` にも使う。`none` の Modal には「保存」が無く、
 * 画面に出る経路は無い（039 実装プラン §8 の 5）。
 */
export const CREDENTIAL_NONE_NOTE =
  'この SNS の配信 Plugin は資格情報を使いません。入力は要りません。';

/** 入れ直し・項目ごとの欄の説明（設計 §7.3.2）。**丸ごと置き換える**ことを書く。 */
export const CREDENTIAL_FIELDS_NOTE =
  '保存済みの値は表示しません。保存すると、保存済みの資格情報はすべてここで入力した値に置き換わります（一部の項目だけを変えることはできません）。';

/** 入れ直し・汎用の欄の説明（設計 §7.1.1 / §7.3.2）。形式を確かめないことを書く。 */
export const CREDENTIAL_FREE_NOTE =
  'この SNS の配信 Plugin が有効になっていないため、入力した値を形式を確かめずにそのまま保存します。配信 Plugin を有効にした後は、その Plugin の項目で入れ直してください。';

/** 資格情報を使わない provider に保存済みの値が残っているときの警告（設計 §7.3.2 / §7.5）。 */
export const CREDENTIAL_NONE_WARNING = [
  '保存済みの資格情報がありますが、いまの配信 Plugin では使われません。',
  '同じ SNS の別の配信 Plugin に入れ替えるとその Plugin が読み、形式が合わなければ自動配信が失敗します。不要なら消してください。',
] as const;

/** 入れ直しの Modal の対象の行（設計 §7.3.2）。 */
export function credentialTargetLabel(displayName: string, providerName: string): string {
  return `対象：${displayName}（${providerName}）`;
}

/** 消去の確認の本文（設計 §7.4）。 */
export function credentialClearMessage(displayName: string): string {
  return `「${displayName}」の保存済みの資格情報を消します。消した値は元に戻せません。`;
}

// ---------------------------------------------------------------------------
// アカウントの ID の表示とコピー（051-social-account-id-display 設計 §7.6）
// ---------------------------------------------------------------------------

/** 一覧の列の見出し。 */
export const ACCOUNT_ID_HEADER = 'アカウントID';

/** 行の「コピー」ボタンの見える文字。 */
export const ACCOUNT_ID_COPY_LABEL = 'コピー';

/**
 * 「コピー」ボタンの `aria-label`（設計 §7.3.1）。行ごとに同じ「コピー」が並ぶので、
 * 支援技術では表示名とサービスで行を見分ける。見える文字「コピー」を名前に含む。
 */
export function accountIdCopyAriaLabel(displayName: string, providerLabel: string): string {
  return `「${displayName}（${providerLabel}）」のアカウントIDをコピー`;
}

export const ACCOUNT_ID_COPIED = 'アカウントIDをコピーしました。';

/** 写せないとき（設計 §7.3.3）。ID の要素は 1 回のクリックで全体が選ばれる。 */
export const ACCOUNT_ID_COPY_FAILED =
  'コピーできませんでした。アカウントIDを選択して写してください。';

// ---------------------------------------------------------------------------
// アカウントのサイト（053-site-scoped-social 設計 §9.1）
// ---------------------------------------------------------------------------

/** 一覧の列の見出しと、追加の Modal の欄の名前（設計 §9.1.1・§9.1.2）。 */
export const SITE_COLUMN_HEADER = 'サイト';
/** サイトに紐づかないアカウント（どのサイトのトークンからも使える）。 */
export const SITE_COMMON_LABEL = '共通';
/** 追加の Modal・「サイト」の Modal の「共通」の選択肢。 */
export const SITE_COMMON_OPTION = '共通（どのサイトのトークンからも使える）';
/** サイトの名前を引けない（`site.read` が無い・一覧に無い）ときの表示。 */
export const SITE_UNNAMED_LABEL = 'サイト専用';
/** アーカイブしたサイトの名前に添える。 */
export const SITE_ARCHIVED_SUFFIX = '（アーカイブ）';
export const SITE_SELECT_DESCRIPTION =
  'サイトを選ぶと、そのサイトに紐づいた API トークンからだけ使えます。管理画面からはいつでも使えます。';
/** `site.read` が無いときの追加の Modal の説明（設計 §9.1.2）。 */
export const SITE_SELECT_NO_PERMISSION = 'サイトの一覧を見る権限が無いため、共通で登録します。';

/** 行の「サイト」ボタン（設計 §9.1.3）。 */
export const SITE_CHANGE_LABEL = 'サイト';
export const SITE_CHANGE_TITLE = 'サイトの紐づけを変える';
export const SITE_CHANGE_WARNING =
  'このアカウントの投稿（予約・承認待ちを含む）は、変更後のサイトのトークンからだけ見えるようになります。登録済みの予約はそのまま配信されます。';
export const SITE_CHANGED = 'サイトの紐づけを変えました。';

/** アカウント一覧の絞り込み（設計 §9.1.4。裁定 9）。 */
export const SITE_FILTER_LABEL = 'サイトで絞り込む';
export const SITE_FILTER_ALL = 'すべて';

/** サイトの表示名。アーカイブしたサイトは「（アーカイブ）」を添える（設計 §9.1.1）。 */
export function siteNameLabel(site: { readonly name: string; readonly status: string }): string {
  return site.status === 'archived' ? `${site.name}${SITE_ARCHIVED_SUFFIX}` : site.name;
}

/** 投稿一覧の「登録元」（054-bulk-post-actions 設計 §5.6・§9.1・§9.10）。 */
export const POST_SOURCE_COLUMN_HEADER = '登録元';
/** トークンを経ない（画面で）登録した投稿。 */
export const POST_SOURCE_SCREEN_LABEL = '管理画面';
/** 失効したトークンの名前に添える。 */
export const POST_SOURCE_REVOKED_SUFFIX = '（失効）';
/** 行が消えたトークン（所有者の削除）の名前に添える。 */
export const POST_SOURCE_DELETED_SUFFIX = '（削除済み）';
/** 絞り込みの「行が消えたトークン」の選択肢。 */
export const POST_SOURCE_DELETED_OPTION = '削除されたトークン';
/** 絞り込みで同じ名前のトークンを見分ける添え字。`{date}` は発行日。 */
export const POST_SOURCE_ISSUED_SUFFIX = '（発行 {date}）';

/** 投稿一覧の絞り込みの帯（設計 §9.2）。 */
export const POST_FILTER_STATUS_LABEL = '状態';
export const POST_FILTER_ACCOUNT_LABEL = 'アカウント';
export const POST_FILTER_SOURCE_LABEL = '登録元';
export const POST_FILTER_PER_PAGE_LABEL = '表示件数';
export const POST_FILTER_ALL = 'すべて';
export const POST_FILTER_CLEAR = '条件をクリア';
export const POST_FILTER_EMPTY = '条件に合う投稿がありません。';

// ---------------------------------------------------------------------------
// 投稿の選択と一括操作（054-bulk-post-actions 設計 §9.3〜§9.7・§9.9・§9.10）
// ---------------------------------------------------------------------------

/** 見出しの一括選択のチェックボックスの `aria-label`（設計 §9.3）。 */
export const SELECT_PAGE_LABEL = 'このページの投稿をすべて選択';

/** 行のチェックボックスの `aria-label`。行を見分けるため本文の抜粋を添える（設計 §9.1）。 */
export function SELECT_ROW_LABEL(excerpt: string): string {
  return `この投稿を選択：${excerpt}`;
}

/** 一括の帯の選択の件数（設計 §9.3）。 */
export function SELECTED_COUNT(count: number): string {
  return `${count} 件を選択中`;
}

/** 表示中の全行を選んだが、絞り込みに合う投稿はほかのページにもあるとき（設計 §5.3・§9.3）。 */
export function SELECTED_PAGE_COUNT(count: number, total: number): string {
  return `このページの ${count} 件を選択中（全 ${total} 件）`;
}

/** 一括送信（設計 §9.4・§9.5）。帯のボタンは末尾に「…」を足す（ダイアログを開く）。 */
export const BULK_SEND_LABEL = '一括送信（承認）';
export const BULK_SEND_TITLE = '一括送信（承認）';
export const BULK_SEND_NOW_OPTION = APPROVE_NOW_LABEL;
export const BULK_SEND_DESIRED_OPTION = 'それぞれの希望日時に投稿';
export const BULK_SEND_CONFIRM = '送る';

/** 一括送信のダイアログの書き出し。 */
export function BULK_SEND_LEAD(selected: number, targets: number): string {
  return `選んだ ${selected} 件のうち、次の ${targets} 件を送ります。`;
}

export function BULK_SEND_APPROVE_LINE(count: number): string {
  return `承認待ち ${count} 件を承認します`;
}

export function BULK_SEND_PUBLISH_NOW_LINE(count: number): string {
  return `予約済み ${count} 件を今すぐ送ります`;
}

/** 「それぞれの希望日時」で承認されない行の警告（結果はサーバが返す。設計 §9.5）。 */
export function BULK_SEND_WARN_DESIRED_PAST(count: number): string {
  return `希望日時を過ぎている ${count} 件は、「${BULK_SEND_DESIRED_OPTION}」では承認されません（結果に出ます）。`;
}

export function BULK_SEND_WARN_NO_DESIRED(count: number): string {
  return `希望日時が無い ${count} 件は、「${BULK_SEND_DESIRED_OPTION}」では承認されません（結果に出ます）。`;
}

/** 手動投稿のみの SNS の承認は常に即投稿になる（048 裁定 5）。 */
export function BULK_SEND_NOTE_MANUAL_ONLY(count: number): string {
  return `手動投稿のみの SNS の ${count} 件は、常に即投稿になります。`;
}

/** 今すぐ送る手動投稿は「手動投稿待ち」に並ぶ（設計 §5.4）。 */
export function BULK_SEND_NOTE_MANUAL_DELIVERY(count: number): string {
  return `手動投稿の ${count} 件は、「${MANUAL_PENDING_LABEL}」に並びます。`;
}

/** 一括取り消し（設計 §9.4・§9.6）。**ボタンの文言に「削除」を含めない**（既存の E2E の locator と取り違えない）。 */
export const BULK_DELETE_LABEL = '一括取り消し';
export const BULK_DELETE_TITLE = '投稿を一括で取り消しますか？';
export const BULK_DELETE_CAMPAIGN_NOTE = 'キャンペーンとの紐づけも削除されます。';

/** 一括取り消しのダイアログの本文。`breakdown` は状態ごとの内訳。 */
export function BULK_DELETE_MESSAGE(selected: number, targets: number, breakdown: string): string {
  return `選んだ ${selected} 件のうち ${targets} 件を削除します（${breakdown}）。`;
}

/** 対象外の理由ごとの表示名（設計 §9.5・§9.6）。状態の名前は `POST_STATUS_LABEL` と同じ。 */
export const BULK_EXCLUDED_LABEL = {
  no_permission: '承認の権限なし',
  scheduled_unchanged: '予約済み（変更なし）',
  due_or_publishing: '配信待ち・配信中',
  publishing: '配信中',
  draft: POST_STATUS_LABEL.draft,
  published: POST_STATUS_LABEL.published,
  failed: POST_STATUS_LABEL.failed,
} as const satisfies Record<string, string>;

export type BulkExcludedReason = keyof typeof BULK_EXCLUDED_LABEL;

/** 対象外の件数と内訳。 */
export function BULK_EXCLUDED_TEXT(count: number, breakdown: string): string {
  return `対象外 ${count} 件（${breakdown}）`;
}

/** 結果（設計 §9.7）。 */
export const BULK_RESULT_TITLE = '一括操作の結果';
export const BULK_RESULT_RETRY_HINT = '処理されなかった投稿は、絞り込みで探して選び直せます。';
export const BULK_RESULT_CLOSE = '閉じる';

/** 成功の件数。`breakdown` は効果ごとの内訳（無ければ空）。 */
export function BULK_RESULT_SUCCEEDED(count: number, breakdown: string): string {
  return breakdown === ''
    ? `${count} 件を処理しました。`
    : `${count} 件を処理しました（${breakdown}）。`;
}

export function BULK_RESULT_FAILED(count: number): string {
  return `${count} 件は処理されませんでした。`;
}

/** 行の「削除」が通ったときの Toast（投稿タブ・送信待ちタブ。055-social-pending-tab 設計 §9.3.4）。 */
export const SINGLE_DELETED_TOAST = '削除しました。';

/** 一括取り消しが全件成功したときの Toast。 */
export function BULK_DELETED_TOAST(count: number): string {
  return `${count} 件を削除しました。`;
}

/** 要求そのものが失敗した項目の理由（設計 §9.5）。下にエラーの文言を出す。 */
export const BULK_REQUEST_FAILED_LABEL = '要求が失敗しました';

/** 成功の効果ごとの表示名（設計 §8.1 の `BULK_EFFECTS` とキーをちょうど一致させる）。 */
export const BULK_EFFECT_LABEL: Record<BulkEffect, string> = {
  approved_now: '承認',
  approved_scheduled: '承認（希望日時）',
  approved_forced_now: '承認（手動投稿のみのため即投稿）',
  queued: '今すぐ送る',
  manual_pending: '今すぐ送る（手動投稿待ち）',
  deleted: '削除',
};

/** 失敗の理由ごとの表示名（設計 §8.1 の `BULK_FAILURE_REASONS` とキーをちょうど一致させる）。 */
export const BULK_REASON_LABEL: Record<BulkFailureReason, string> = {
  not_found: '見つかりませんでした',
  not_applicable: '操作の対象の状態ではありません',
  already_due: '既に配信の順番を待っています',
  publishing: '配信中です',
  approval_required: '承認の権限が要ります',
  stale: '内容が変わっています。読み込み直してから操作してください',
  no_desired_time: '希望日時がありません',
  desired_time_passed: '希望日時を過ぎています',
  validation: '配信の条件を満たしていません',
  timeout: '時間内に処理できませんでした',
  internal_error: 'エラーが発生しました',
};

/** 設定 → API の発行フォームの「名前」の説明に足す（設計 §9.9）。 */
export const API_TOKEN_NAME_SOURCE_NOTE =
  'この名前は、SNS 画面の投稿一覧に『登録元』として表示されます（SNS の閲覧権限を持つ人に見えます）。外部アプリが分かる名前にしてください。';

// ---------------------------------------------------------------------------
// タブと送信待ち（055-social-pending-tab 設計 §9.1〜§9.5・§9.8・§9.9）
// ---------------------------------------------------------------------------

/** タブの並びの `aria-label`（設計 §9.1）。 */
export const SOCIAL_TABS_LABEL = 'SNSのタブ';

/** タブの表示名（設計 §5.1）。 */
export const SOCIAL_TAB_LABEL: Record<SocialTabKey, string> = {
  pending: '送信待ち',
  posts: '投稿',
  accounts: 'アカウント',
  history: '配信履歴',
};

/** 送信待ちタブの見出し（設計 §9.3.3）。 */
export const PENDING_HEADING = '送信待ち';

/** 送信待ちの区分の表示名（設計 §5.2）。キーは `PENDING_KINDS` とちょうど一致させる。 */
export const PENDING_KIND_LABEL: Record<PendingKind, string> = {
  manual_pending: MANUAL_PENDING_LABEL,
  awaiting_approval: APPROVAL_PENDING_LABEL,
  scheduled: POST_STATUS_LABEL.scheduled,
};

/** 条件なしの 0 件（設計 §9.3.2）。条件ありの 0 件は投稿タブと同じ `POST_FILTER_EMPTY`。 */
export const PENDING_EMPTY = '送信待ちの投稿はありません。';
export const PENDING_EMPTY_POSTS_LINK = '投稿の一覧を見る';

/** 状態の選択肢に件数を添える（設計 §9.2）。 */
export function PENDING_COUNT_OPTION(label: string, count: number): string {
  return `${label}（${count}）`;
}

/** 並び順の `Select`（ユーザー裁定 7。設計 §9.2）。キーは `PENDING_SORTS` とちょうど一致させる。 */
export const PENDING_SORT_LABEL = '並び順';
export const PENDING_SORT_OPTION_LABEL: Record<PendingSort, string> = {
  action: '手が要るもの順',
  time: '予定の時刻順',
};

/** 手動投稿待ちの経過（設計 §9.3.1）。`elapsed` は Server Component が作る「12 分」の形。 */
export function PENDING_ELAPSED_NOTE(elapsed: string): string {
  return `（${elapsed}経過）`;
}

/** 承認待ちの日時の列で、希望日時であることを添える（設計 §9.3.1）。 */
export const PENDING_DESIRED_NOTE = '希望';

/** 承認待ちの手動投稿の補足（設計 §5.5）。`resolveManualHandoff` の `not_scheduled` と同じ文言。 */
export const PENDING_AWAITING_MANUAL_NOTE = MANUAL_HANDOFF_REASON_LABEL.not_scheduled;

/** ダッシュボード・投稿一覧から送信待ちタブの絞り込みへ飛ぶ先（設計 §9.8）。 */
export const PENDING_MANUAL_HREF = '/social?pendingStatus=manual_pending';
export const PENDING_APPROVAL_HREF = '/social?pendingStatus=awaiting_approval';

/** 自動配信の予約で配信に着手している（設計 §9.3.1）。 */
export const PENDING_PUBLISHING_NOTE = '（配信中）';

/** 承認待ちで手動投稿しかできない SNS（承認は常に即投稿。048 裁定 5。設計 §9.3.1）。 */
export const PENDING_MANUAL_ONLY_NOTE = '承認は常に即投稿になります';

/** 行の「投稿した」のダイアログ（035-social-publishing 設計 §7.1 の区画のまま。055 設計 §9.3.4）。 */
export const MANUAL_DONE_DIALOG_TITLE = '投稿を記録しますか？';
export const MANUAL_DONE_DIALOG_MESSAGE =
  'SNS 側で投稿し終えたことを記録します。投稿の URL が分かれば、履歴から辿れます。';
export const MANUAL_DONE_URL_LABEL = '投稿の URL（任意）';
export const MANUAL_DONE_CONFIRM_LABEL = '記録する';
export const MANUAL_DONE_TOAST = '投稿したことを記録しました。';

/** 行の「取りやめ」の確認（035 設計 §7.1 の区画のまま）。 */
export const MANUAL_CANCEL_CONFIRM_TITLE = '予約を取りやめますか？';
export const MANUAL_CANCEL_CONFIRM_MESSAGE = '下書きに戻します。予約は解除されます。';
export const MANUAL_CANCEL_CONFIRM_LABEL = '取りやめる';
export const MANUAL_CANCELLED_TOAST = '予約を取りやめ、下書きに戻しました。';

/** 行の「投稿した」の 409 の Toast（設計 §9.3.4）。他の失敗はサーバの文言。 */
export const MANUAL_OUTCOME_STALE_MESSAGE =
  '内容が変わっています。読み込み直してから操作してください。';

/** 選んだ手動投稿を順に投稿（ユーザー裁定 6。設計 §9.5）。帯のボタンは末尾に「…」を足す。 */
export const MANUAL_SEQUENCE_LABEL = '選んだ手動投稿を順に投稿';

/** ダイアログの見出し。`index` は 1 から数える。 */
export function MANUAL_SEQUENCE_TITLE(index: number, total: number): string {
  return `手動投稿（${index} / ${total} 件目）`;
}

export const MANUAL_SEQUENCE_POSTED = MANUAL_PENDING_DONE_LABEL;
export const MANUAL_SEQUENCE_NOT_POSTED = '投稿しなかった';
export const MANUAL_SEQUENCE_QUIT = 'やめる';
export const MANUAL_SEQUENCE_SKIP = '飛ばして次へ';

/** 「投稿しなかった」の確認（設計 §9.5.2）。`excerpt` は本文の抜粋。 */
export function MANUAL_SEQUENCE_CONFIRM_TITLE(excerpt: string): string {
  return `「${excerpt}」を失敗として確定しますか？`;
}

export const MANUAL_SEQUENCE_CONFIRM_MESSAGE =
  '配信履歴に「失敗」として残ります。やり直すには新しい投稿を作ります。この操作は取り消せません。';
export const MANUAL_SEQUENCE_CONFIRM_LABEL = '失敗にする';
export const MANUAL_SEQUENCE_BACK = '戻る';

/** 記録した件数（設計 §9.5.2）。`breakdown` は結果ごとの内訳（無ければ空）。 */
export function MANUAL_SEQUENCE_PROGRESS(count: number, breakdown: string): string {
  return breakdown === '' ? `記録済み ${count} 件` : `記録済み ${count} 件（${breakdown}）`;
}

/** 最後の件を記録した後の表示（設計 §9.5.2）。 */
export function MANUAL_SEQUENCE_DONE(posted: number, notPosted: number, skipped: number): string {
  return `すべての手動投稿を記録しました（${MANUAL_SEQUENCE_POSTED} ${posted}・${MANUAL_SEQUENCE_NOT_POSTED} ${notPosted}・${MANUAL_SEQUENCE_SKIPPED} ${skipped}）。`;
}

/** 閉じたときの Toast（設計 §9.5.2）。1 件でも記録していれば出す。 */
export function MANUAL_SEQUENCE_TOAST(total: number, posted: number, notPosted: number): string {
  return `${total} 件を記録しました（${MANUAL_SEQUENCE_POSTED} ${posted}・${MANUAL_SEQUENCE_NOT_POSTED} ${notPosted}）。`;
}

/** ダイアログの今の件の予約日時に添える（設計 §9.5.2）。 */
export const MANUAL_SEQUENCE_SCHEDULED_LABEL = '予約';

/** 記録の内訳の「飛ばした」（設計 §9.5.2）。 */
export const MANUAL_SEQUENCE_SKIPPED = '飛ばした';

/** 順に投稿の対象外の理由ごとの表示名（設計 §9.5.1）。 */
export const MANUAL_SEQUENCE_EXCLUDED_LABEL = {
  awaiting_approval: APPROVAL_PENDING_LABEL,
  handoff_unavailable: '投稿画面を開けない',
  auto: '自動配信',
} as const satisfies Record<string, string>;

/** 順に投稿の 409 の `Alert`（設計 §9.5.2）。他の失敗はサーバの文言。 */
export const MANUAL_SEQUENCE_STALE_MESSAGE =
  '内容が変わっています。この投稿は飛ばして次へ進めます。';

/** 窓を開いた後の案内（057-social-bulk-post 設計 §5.4 の `opened`）。 */
export const MANUAL_SEQUENCE_OPENED_GUIDE =
  'SNS の窓で投稿したら、窓を閉じてこの画面に戻ってください。戻ると記録のボタンが出ます。窓が開かないときは『別のタブで開く』を使ってください。';

/** 戻らずに記録のボタンを出す（057 設計 §5.4）。 */
export const MANUAL_SEQUENCE_RECORD_NOW = '記録へ進む';

/** 記録のボタンに添える。次の件があるときだけ（057 設計 §5.4 の `returned`）。 */
export const MANUAL_SEQUENCE_NEXT_GUIDE = '選ぶと次の投稿画面が開きます。';

/** 記録に失敗したが、次の件の窓はもう開いている（057 設計 §7.5）。 */
export const MANUAL_SEQUENCE_NEXT_OPENED = '次の投稿画面は開いています。';

// ---------------------------------------------------------------------------
// 送信待ちタブの一括投稿（057-social-bulk-post 設計 §7.2〜§7.6）
// ---------------------------------------------------------------------------

/** 終わりの表示の題（順に投稿の後も、順に投稿の無い一括投稿の結果も。057 実装プラン §8 の 21）。 */
export const BULK_POST_RESULT_TITLE = '一括投稿の結果';

/** 手動投稿の記録の内訳（例「手動投稿：投稿した 2・飛ばした 1」）。0 件の結果は書かない。 */
export function BULK_POST_MANUAL_RESULT(
  posted: number,
  notPosted: number,
  skipped: number,
): string {
  const breakdown = (
    [
      [MANUAL_SEQUENCE_POSTED, posted],
      [MANUAL_SEQUENCE_NOT_POSTED, notPosted],
      [MANUAL_SEQUENCE_SKIPPED, skipped],
    ] as const
  )
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${label} ${count}`)
    .join('・');
  return `手動投稿：${breakdown}`;
}

/** 途中でやめたとき（057 設計 §7.5）。まだ記録していない件は何も変えていない。 */
export function BULK_POST_UNRECORDED(count: number): string {
  return `記録していない手動投稿 ${count} 件は送信待ちに残ります。`;
}

// ---------------------------------------------------------------------------
// 一覧の 2 段目の本文（056-social-row-layout 設計 §5.3）
// ---------------------------------------------------------------------------

/** 2 段目の本文のセルの、読み上げ用の見出し（画面には出さない）。 */
export const POST_BODY_PREVIEW_LABEL = '本文';
