/**
 * SNS画面の表示文言。
 *
 * **コンポーネントの中に直書きしない**（`02_画面デザイン方針.md` §5）。
 * 一覧とフォームで同じ状態に別の言い方をすると、同じものだと分からなくなる。
 * 国際化はこの計画ではやらないが、差し替える場所を1つにはしておく。
 */

import { PUBLISH_MAX_SKIPS } from '@/domain/social/publishing';
import type { AccountStatus, DeliveryMode, PostStatus } from '@/domain/social/social';

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

/** ダッシュボードから飛んで来る先（設計 §7.6）。 */
export const MANUAL_PENDING_ANCHOR = 'manual-pending';

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
} as const satisfies Record<string, string>;

// ---------------------------------------------------------------------------
// 承認待ち（048-social-post-approval 設計 §7.1〜§7.6）
// ---------------------------------------------------------------------------

export const APPROVAL_PENDING_LABEL = '承認待ち';

/** ダッシュボードと投稿一覧から飛んで来る先（設計 §7.1・§7.3・§7.5）。 */
export const APPROVAL_PENDING_ANCHOR = 'approval-pending';

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

/** 投稿一覧の状態列の補足（設計 §7.3）。 */
export const APPROVAL_PENDING_ROW_NOTE = '（区画で承認）';
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
