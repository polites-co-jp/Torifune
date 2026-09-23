import type {
  PluginSettingsField,
  PublisherLimits,
  PublisherRegistration,
  PublisherValidationProblem,
  SocialPostDraftView,
} from '@torifune/plugin-api';
import { buildThreadsManualHandoff, checkThreadsText } from './threads-text';
import type { FetchImpl } from './threads-api';

/**
 * Threads API で投稿する publisher（040-sns-threads 設計 §5〜§9）。
 *
 * **Plugin が書くのは「1 回配信する関数」と「投稿画面の URL を返す関数」だけ。**
 * いつ送るか・再試行・記録・画面は Core が持つ。
 *
 * 状態を 1 つも持たない（設計 §5.3）。
 */

/** `social_accounts.provider` と同じ値。Core の既知の provider の一覧には無い（設計 §11 #1）。 */
export const THREADS_PROVIDER = 'threads';

/** 表示名。Plugin が有効な間はこれが出る。 */
export const THREADS_LABEL = 'Threads';

/** テストのための口（設計 §10.1）。**`store` を受け取らない**（状態を持たない。設計 §5.3）。 */
export interface ThreadsPublisherOptions {
  /** 外部への HTTP。既定は Node の標準実装。**テストはここを差し替える**。`index.ts` は与えない。 */
  readonly fetch?: FetchImpl;
  /** この Plugin が見る時計。既定は現在時刻。期限の判定（設計 §6.8）とトークンの期限（設計 §6.7）がこれを見る。 */
  readonly now?: () => Date;
  /** ポーリングの待ち。既定は `setTimeout` を signal で打ち切る実装。 */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * 資格情報の形（設計 §5.1）。**3 つで確定。後から足せない**（足すと既存のアカウントの配信が全部 `failed` になる）。
 *
 * `description` は `/social` の欄の下に出る。ユーザー ID とユーザーネームの取り違え・権限の不足は、
 * 入力の時点で読まれるここに書く。
 */
const CREDENTIAL_FIELDS: readonly PluginSettingsField[] = [
  {
    key: 'threadsUserId',
    label: 'Threads ユーザー ID',
    description:
      'Threads のユーザー ID。数字だけの文字列です（長期アクセストークンで /me を問い合わせると分かります）。' +
      '@ で始まるユーザーネームではありません。',
    kind: 'text',
    placeholder: '17841400000000000',
  },
  {
    key: 'accessToken',
    label: '長期アクセストークン',
    description:
      'Threads API で発行した長期アクセストークン。threads_basic と threads_content_publish の権限が要ります。' +
      '60 日で失効します。Torifune は配信が成功したときに残り日数を見て、必要なら延長して保存し直します。保存後は再表示されません。',
    kind: 'secret',
  },
  {
    key: 'accessTokenExpiresAt',
    label: 'トークンの有効期限',
    description:
      'トークンの有効期限（例：2026-11-23T00:00:00Z）。分からなければ unknown と入れてください。' +
      '次に配信が成功したとき、Torifune がトークンを延長して正しい期限に書き換えます。',
    kind: 'text',
    placeholder: 'unknown',
  },
];

/**
 * Core が登録時と配信直前に適用する制約（設計 §9.1）。
 *
 * **`bodyMaxLength` を宣言しない。** 本文の判定は `validate()`（`checkThreadsText`）が §9.4 の数え方で行う。
 * 二重に書くと、後で `validate()` を緩めたときに片方だけが厳しい側に残る。
 * **`mediaRequired` を宣言しない**（テキストだけの投稿ができる）。
 * `mediaMax` は Core の投稿の上限（10）に合わせる（Threads の carousel は 20 件まで受けるが、Core が 10 で抑える）。
 */
const LIMITS: PublisherLimits = { mediaMax: 10 };

/**
 * 登録時と配信直前の事前検査（設計 §9.2）。
 *
 * **5 秒で打ち切られる。外部へ問い合わせない。同期で返す。例外を投げない。**
 * 本文について言うことは必ず `checkThreadsText` から来る。複数の違反はすべて返す。
 * 媒体の枚数・URL の形・`alt` の長さは Core が見る（設計 §9.2）。
 */
function validateDraft(post: SocialPostDraftView): PublisherValidationProblem[] {
  const problems: PublisherValidationProblem[] = [];

  // 1〜4：本文の片割れ・長さ・URL の本数・intent URL の長さ。
  problems.push(...checkThreadsText(post));

  // 5：外から来た任意の JSON。循環参照を含みうるので、キーの一覧だけを見る。
  const options: unknown = post.providerOptions;
  if (typeof options === 'object' && options !== null && !Array.isArray(options)) {
    for (const key of Object.keys(options)) {
      problems.push({
        field: `providerOptions.${key}`,
        message: `${key} は Threads では使いません。`,
      });
    }
  }

  return problems;
}

/**
 * Threads の publisher を組み立てる。
 *
 * **状態を 1 つも持たない**ので、Key-Value Store を受け取らない（設計 §5.3）。
 * `index.ts` は引数を与えない。差し替えるのはテストだけ（設計 §10.1）。
 *
 * `publish()` は実装プラン G5 で足す。それまで `options` は読まない。
 */
export function createThreadsPublisher(
  _options: ThreadsPublisherOptions = {},
): PublisherRegistration {
  return {
    provider: THREADS_PROVIDER,
    label: THREADS_LABEL,
    credentialFields: CREDENTIAL_FIELDS,
    limits: LIMITS,
    validate({ post }) {
      return validateDraft(post);
    },
    // Web Intent はブラウザでログイン中のアカウントで開くので、`account` を使わない（設計 §9.5）。
    // 要求を出さない・待たない・例外を投げない。
    manual({ post }) {
      return buildThreadsManualHandoff(post);
    },
  };
}
