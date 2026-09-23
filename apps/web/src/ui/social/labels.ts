/**
 * SNS画面の表示文言。
 *
 * **コンポーネントの中に直書きしない**（`02_画面デザイン方針.md` §5）。
 * 一覧とフォームで同じ状態に別の言い方をすると、同じものだと分からなくなる。
 * 国際化はこの計画ではやらないが、差し替える場所を1つにはしておく。
 */

import type { AccountStatus, DeliveryMode, PostStatus } from '@/domain/social/social';

export const POST_STATUS_LABEL: Record<PostStatus, string> = {
  draft: '下書き',
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

/** 配信の支度ができていない予約への注意（設計 §7.3、要件 §4 裁定 #8）。 */
export const NO_PUBLISHER_BADGE = '配信 Plugin なし';
export const NO_CREDENTIAL_BADGE = '資格情報 未設定';

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
