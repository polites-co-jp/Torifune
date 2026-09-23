import type {
  PluginSettingsField,
  PublisherLimits,
  PublisherRegistration,
  PublisherValidationProblem,
  SocialPostDraftView,
} from '@torifune/plugin-api';
import { buildXManualHandoff, checkXText } from './x-text';
import type { FetchImpl } from './xapi';

/**
 * X API で投稿する publisher（037-sns-x 設計 §5〜§9。有料版）。
 *
 * **Plugin が書くのは「1 回配信する関数」だけ。** いつ送るか・再試行・記録・画面は Core が持つ。
 * 手動投稿（`manual`）も持ち、`sns-x-manual` と同じ URL を返す（設計 §4.2 / §9.5）。
 *
 * 状態を 1 つも持たない（設計 §5.3）。
 */

/** `social_accounts.provider` と同じ値。`sns-x-manual` と同じ（入れ替えを成り立たせる。設計 §7.2）。 */
export const X_PROVIDER = 'x';

/** 表示名。`sns-x-manual` と同じ。 */
export const X_LABEL = 'X';

export interface XApiPublisherOptions {
  /**
   * 外部への HTTP。既定は Node の標準実装。**テストはここを差し替える**（設計 §10.1）。
   * `index.ts` は与えない。
   */
  readonly fetch?: FetchImpl;
  /** この Plugin が見る時計。既定は現在時刻。署名の時刻と残り時間の判定がこれを見る。 */
  readonly now?: () => Date;
  /** OAuth 1.0a の nonce を作る関数。既定は暗号論的な乱数。 */
  readonly nonce?: () => string;
}

/**
 * 資格情報の形（設計 §5.1）。**OAuth 1.0a の 4 値で確定。後から足せない**（設計 §5.2）。
 */
const CREDENTIAL_FIELDS: readonly PluginSettingsField[] = [
  {
    key: 'apiKey',
    label: 'API Key（Consumer Key）',
    description: 'X の開発者向け画面（Developer Console）でアプリに発行される API Key です。',
    kind: 'text',
  },
  {
    key: 'apiKeySecret',
    label: 'API Key Secret（Consumer Secret）',
    description: 'API Key と対になる Secret です。保存後は再表示されません。',
    kind: 'secret',
  },
  {
    key: 'accessToken',
    label: 'Access Token',
    // 読み取り専用のまま発行したトークンでは投稿が 403 で落ちる。入力の時点で読まれる場所に書く。
    description:
      '投稿するアカウントの Access Token です。アプリの権限を「Read and write」にしてから発行してください' +
      '（権限を変えた後は発行し直す必要があります）。',
    kind: 'text',
  },
  {
    key: 'accessTokenSecret',
    label: 'Access Token Secret',
    description: 'Access Token と対になる Secret です。保存後は再表示されません。',
    kind: 'secret',
  },
];

/**
 * Core が登録時と配信直前に適用する制約（設計 §9.1）。
 *
 * **`bodyMaxLength` を宣言しない。** URL は長さによらず 23 と数えるので、Core の `String.length` に対して
 * 必ず緩い側になる有限の値が無い。本文の判定は `validate()`（`checkXText`）が行う。
 */
const LIMITS: PublisherLimits = { mediaMax: 4 };

/**
 * 登録時と配信直前の事前検査（設計 §9.2）。
 *
 * **5 秒で打ち切られる。外部へ問い合わせない。同期で返す。例外を投げない。**
 * `sns-x-manual` と違い `auto` を断らない。それ以外（本文・`providerOptions`）は同じ判定を返す（#10）。
 * 本文について言うことは必ず `checkXText` から来る。複数の違反はすべて返す。
 */
function validateDraft(post: SocialPostDraftView): PublisherValidationProblem[] {
  const problems: PublisherValidationProblem[] = [];

  // 2・3：本文の重み付きの長さと intent URL の長さ。
  problems.push(...checkXText(post));

  // 4：外から来た任意の JSON。循環参照を含みうるので、キーの一覧だけを見る。
  const options: unknown = post.providerOptions;
  if (typeof options === 'object' && options !== null && !Array.isArray(options)) {
    for (const key of Object.keys(options)) {
      problems.push({ field: `providerOptions.${key}`, message: `${key} は X では使いません。` });
    }
  }

  return problems;
}

export function createXApiPublisher(_options: XApiPublisherOptions = {}): PublisherRegistration {
  return {
    provider: X_PROVIDER,
    label: X_LABEL,
    credentialFields: CREDENTIAL_FIELDS,
    limits: LIMITS,
    validate({ post }) {
      return validateDraft(post);
    },
    // Web Intent はブラウザでログイン中のアカウントで開くので、`account` を使わない（設計 §9.5）。
    manual({ post }) {
      return buildXManualHandoff(post);
    },
  };
}
