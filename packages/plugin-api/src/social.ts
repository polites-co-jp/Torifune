import type { PluginLogger } from './context';
import type { SocialAccountView, SocialPostView } from './data';
import type { PluginSettingsField } from './ui';

/**
 * SNS 配信（035-social-publishing 設計 §9）。
 *
 * **Plugin が書くのは「1 回配信する関数」と「投稿画面の URL を返す関数」だけ。**
 * いつ送るか・再試行・記録・画面は Torifune が持つ。Plugin は自前のタイマーを持たない
 * （複数プロセスで二重投稿するため。SNS の投稿は取り消せない）。
 */

/** 登録時に Torifune が適用する制約。SNS ごとの上限をここで宣言する。 */
export interface PublisherLimits {
  /** 本文の上限（文字数の数え方は SNS ごとに違う。厳密な判定は validate() で行い、ここは早く弾くための粗い上限）。 */
  readonly bodyMaxLength?: number;
  /** 自動配信に媒体が必須か（Instagram）。手動投稿には適用されない。 */
  readonly mediaRequired?: boolean;
  readonly mediaMax?: number;
}

/** 登録前の投稿（まだ ID を持たない）。validate() が受け取る。 */
export type SocialPostDraftView = Pick<
  SocialPostView,
  'body' | 'scheduledAt' | 'deliveryMode' | 'media' | 'link' | 'providerOptions'
>;

/** validate() が返す問題。`field` は要求のフィールド名（`body` / `media` / `link` / `providerOptions.<key>` など）。 */
export interface PublisherValidationProblem {
  readonly field: string;
  readonly message: string;
}

export interface PublishInput {
  readonly post: SocialPostView;
  readonly account: SocialAccountView;
  /**
   * このアカウントの資格情報。**この呼び出しの間だけ有効。**
   *
   * `credentialFields` で宣言したキーがそのまま入る。保存し直さない（`store.setSecret` に写さない）。
   * 更新が要るとき（トークンの延長など）は `rotatedCredential` で返す。**ログに値を渡さない。**
   */
  readonly credential: Readonly<Record<string, string>>;
  /** 何回目の着手か（1 始まり）。 */
  readonly attempt: number;
  /** Torifune が 30 秒で発火する。以後の処理は打ち切ってよい（結果は「不明」として記録される）。 */
  readonly signal: AbortSignal;
  readonly logger: PluginLogger;
}

/**
 * 配信の結果。
 *
 * **`retryable` の基準：「送る前に失敗した」なら true、「届いたか分からない」なら false。**
 * 送信前のネットワーク断・429・（送っていない）認証エラーは true。5xx・タイムアウト・応答の解釈失敗は false。
 * 迷ったら false（二重投稿より未投稿のほうがまし）。**例外を投げると常に「不明」として failed になる。**
 */
export type PublishResult =
  | {
      readonly ok: true;
      /** SNS 側の投稿 ID。NUL（U+0000）と対になっていないサロゲートは U+FFFD に置き換えて記録する。 */
      readonly externalId?: string;
      /**
       * https の URL。履歴画面から辿れるようにする。
       *
       * NUL（U+0000）を含む URL は使わない（開けない URL として記録しない。配信の結果は記録される）。
       */
      readonly externalUrl?: string;
      /** 更新後の資格情報（キーは credentialFields のまま）。Torifune が暗号化して書き戻す。 */
      readonly rotatedCredential?: Readonly<Record<string, string>>;
    }
  | {
      readonly ok: false;
      /**
       * 利用者に見せる理由（履歴画面に出る）。**資格情報を含めない。** 2000 文字で切られる。
       *
       * NUL（U+0000）と対になっていないサロゲートは、資格情報の伏せ字の後に U+FFFD に置き換えて記録する
       * （`publish()` が投げた例外の文言も同じ）。
       */
      readonly reason: string;
      readonly retryable: boolean;
      /** 再試行までの待ち（ms）。Torifune の既定（1 → 2 → 4 → 8 分）より長いときだけ使われる。上限 24 時間。 */
      readonly retryAfterMs?: number;
    };

/** 手動投稿。資格情報は渡らない（Web Intent は公開 URL）。 */
export interface ManualInput {
  readonly post: SocialPostView;
  readonly account: SocialAccountView;
}

export interface ManualHandoff {
  /**
   * 投稿内容を反映した投稿画面の URL。https の絶対 URL、または `/` で始まる Torifune 内のパス。
   *
   * **https の絶対 URL は 2048 文字以内。** 超えると Torifune は使えない URL として扱い、
   * 手動投稿待ちの行が「Plugin が返した URL を開けません」になる。
   * 本文を URL に埋め込む Plugin は、`validate()` で手動投稿のときに URL の長さを確かめ、登録時に断る
   * （日本語 1 文字は URL の中で 9 文字になる）。
   * `/` で始まるパスもいまは長さを検査していないが、同じく 2048 文字以内に収める。
   *
   * **NUL（U+0000）を含む URL は使わない。** Torifune は開けない URL として扱う（上と同じ「Plugin が返した URL を開けません」）。
   */
  readonly url: string;
  /** 画面に添える注意書き（例：「画像は投稿画面で添付してください」）。 */
  readonly note?: string;
}

export interface PublisherRegistration {
  /** `social_accounts.provider` と同じ値（`^[a-z][a-z0-9_]{0,31}$`）。 */
  readonly provider: string;
  /** 表示名。Torifune の対応表より優先される。 */
  readonly label: string;
  /**
   * 資格情報の形。**入力欄と形式検証は Torifune が持つ。**
   * `kind: 'secret'` は打ち込むときに伏せる項目。保存はどの項目も暗号化され、どの項目も再表示されない。
   * 空なら資格情報無しで publish() が呼ばれる（`credential` は `{}`）。
   */
  readonly credentialFields: readonly PluginSettingsField[];
  readonly limits?: PublisherLimits;
  /** 登録時の事前検査。問題が無ければ空配列。 */
  validate?(input: {
    readonly post: SocialPostDraftView;
    readonly account: SocialAccountView;
  }): readonly PublisherValidationProblem[] | Promise<readonly PublisherValidationProblem[]>;
  /**
   * 自動配信。
   *
   * **実装しなくても予約そのものは断られない。** 配信の支度が整うまで、
   * Torifune がその投稿を飛ばして待つ（035-social-publishing 設計 §6.1.2）。
   */
  publish?(input: PublishInput): Promise<PublishResult>;
  /** 手動投稿。実装しなければ、この provider の `deliveryMode: 'manual'` は 422 で断られる。 */
  manual?(input: ManualInput): ManualHandoff | Promise<ManualHandoff>;
}

/**
 * SNS 配信の登録口。
 *
 * **Manifest で `extensions: ['social']` を宣言していなければ使えない**（`PluginExtensionNotDeclaredError`）。
 * 宣言なしに登録できると、Plugin を入れた側が「どの Plugin が資格情報を受け取るか」を知らないまま運用することになる。
 */
export interface PluginSocialApi {
  registerPublisher(registration: PublisherRegistration): void;
}

/** 同じ provider を別の Plugin が既に登録している。 */
export class PluginPublisherConflictError extends Error {
  constructor(
    readonly provider: string,
    readonly registeredBy: string,
  ) {
    super(`provider ${provider} は Plugin ${registeredBy} が既に登録している`);
    this.name = 'PluginPublisherConflictError';
  }
}
