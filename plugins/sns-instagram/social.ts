import type {
  PluginSettingsField,
  PublisherLimits,
  PublisherRegistration,
  PublisherValidationProblem,
  SocialPostDraftView,
} from '@torifune/plugin-api';
import { countHashtags, countMentions } from './caption';

/**
 * Instagram（Graph API の Content Publishing）の publisher（038-sns-instagram 設計 §9）。
 *
 * **Plugin が書くのは「1 回配信する関数」だけ。** いつ送るか・再試行・記録・画面は Core が持つ。
 * **手動投稿（`manual`）は実装しない。** キーごと置かないので、Core が
 * `deliveryMode: 'manual'` を 422 で断る（設計 §9.3）。
 */

/** `social_accounts.provider` と同じ値。 */
export const INSTAGRAM_PROVIDER = 'instagram';

/** 1 投稿のハッシュタグの上限。 */
const HASHTAG_MAX = 30;

/** 1 投稿のメンションの上限。 */
const MENTION_MAX = 20;

export interface InstagramPublisherOptions {
  /**
   * 外部への HTTP。既定は Node の標準実装。**テストはここを差し替える**（設計 §10.1）。
   * `index.ts` は与えない。
   */
  readonly fetch?: typeof globalThis.fetch;
  /** この Plugin が見る時計。既定は現在時刻。期限の判定とトークンの期限がこれを見る。 */
  readonly now?: () => Date;
  /** 状態の確認の待ち。既定は `setTimeout` を signal で打ち切る実装。**テストは実時間を待たない。** */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * 資格情報の形（設計 §5.1）。**3 項目で確定。後から足せない**（設計 §5.2）。
 */
const CREDENTIAL_FIELDS: readonly PluginSettingsField[] = [
  {
    key: 'igUserId',
    label: 'Instagram ユーザー ID',
    description:
      'Instagram のプロアカウント（ビジネスまたはクリエイター）の ID。数字だけの文字列です。' +
      '@ で始まるユーザーネームではありません。',
    kind: 'text',
    placeholder: '17841400000000000',
  },
  {
    key: 'accessToken',
    label: '長期アクセストークン',
    description:
      'Instagram API（Instagram ログイン）で発行した長期アクセストークン。' +
      'instagram_business_basic と instagram_business_content_publish の権限が要ります。' +
      '60 日で失効します。Torifune は配信のたびに残り日数を見て、必要なら延長して保存し直します。保存後は再表示されません。',
    kind: 'secret',
  },
  {
    key: 'accessTokenExpiresAt',
    label: 'トークンの有効期限',
    description:
      'トークンの有効期限（例：2026-11-22T00:00:00Z）。分からなければ unknown と入れてください。' +
      '次に配信が成功したとき、Torifune がトークンを延長して正しい期限に書き換えます。',
    kind: 'text',
    placeholder: 'unknown',
  },
];

/**
 * Core が登録時と配信直前に適用する制約（設計 §9.1）。
 *
 * `bodyMaxLength` は厳しい側（`String.length`）に置いたまま。Instagram のキャプションの数え方は公開されていない。
 */
const LIMITS: PublisherLimits = { bodyMaxLength: 2200, mediaRequired: true, mediaMax: 10 };

const LINK_MESSAGE =
  'Instagram はキャプション内の URL をリンクにしません。link は指定できません' +
  '（URL を見せたい場合は本文に書いてください。リンクにはなりません）。';

/**
 * 登録時と配信直前の事前検査（設計 §9.2）。
 *
 * **5 秒で打ち切られる。外部へ問い合わせない。同期で返す。例外を投げない。**
 * 本文の長さ・媒体の枚数と有無・`media[].url` の形・`alt` は見ない（Core が見る／送らないので断らない）。
 * `deliveryMode` で分岐しない。複数の違反はすべて返す。
 */
function validateDraft(post: SocialPostDraftView): readonly PublisherValidationProblem[] {
  const problems: PublisherValidationProblem[] = [];

  const body = typeof post.body === 'string' ? post.body : '';

  const hashtagCount = countHashtags(body);
  if (hashtagCount > HASHTAG_MAX) {
    problems.push({
      field: 'body',
      message: `Instagram のハッシュタグは${HASHTAG_MAX}個までです。いまは ${hashtagCount} 個です。`,
    });
  }

  const mentionCount = countMentions(body);
  if (mentionCount > MENTION_MAX) {
    problems.push({
      field: 'body',
      message: `Instagram のメンションは${MENTION_MAX}件までです。いまは ${mentionCount} 件です。`,
    });
  }

  // **黙って捨てない。** 本文の末尾へ足すと Core が数えた長さと食い違う（設計 §6.12）。
  const link: unknown = post.link;
  if (link !== null && link !== undefined && link !== '') {
    problems.push({ field: 'link', message: LINK_MESSAGE });
  }

  // 外から来た任意の JSON。循環参照を含みうるので、キーの一覧だけを見る。
  const options: unknown = post.providerOptions;
  if (typeof options === 'object' && options !== null && !Array.isArray(options)) {
    for (const key of Object.keys(options)) {
      problems.push({
        field: `providerOptions.${key}`,
        message: `${key} は Instagram では使いません。`,
      });
    }
  }

  return problems;
}

/**
 * Instagram の publisher を組み立てる。
 *
 * **状態を 1 つも持たない**ので、Key-Value Store を受け取らない（設計 §5.3）。
 */
export function createInstagramPublisher(
  _options: InstagramPublisherOptions = {},
): PublisherRegistration {
  return {
    provider: INSTAGRAM_PROVIDER,
    label: 'Instagram',
    credentialFields: CREDENTIAL_FIELDS,
    limits: LIMITS,
    validate: ({ post }) => validateDraft(post),
  };
}
