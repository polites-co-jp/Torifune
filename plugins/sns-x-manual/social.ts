import type {
  PublisherRegistration,
  PublisherValidationProblem,
  SocialPostDraftView,
} from '@torifune/plugin-api';
import { buildXManualHandoff, checkXText } from './x-text';

/**
 * X の手動投稿だけを持つ publisher（037-sns-x 設計 §9。無料版）。
 *
 * **`publish` と `limits` のキーを置かない**（`publish: undefined` とも書かない）。
 * Core は `publish` を持たない publisher の `auto` の予約を断らずに後ろへ送るので、
 * 利用者が黙って待たされないよう `validate()` で `auto` を断る（設計 §9.3）。
 *
 * 外へ 1 本も要求を出さない。資格情報を受け取らない。状態を持たない（設計 §5.3）。
 */

/** `social_accounts.provider` と同じ値。`sns-x-api` と同じ（入れ替えを成り立たせる。設計 §7.2）。 */
export const X_PROVIDER = 'x';

/** 表示名。`sns-x-api` と同じ。 */
export const X_LABEL = 'X';

/** 無料版で `auto` を選んだときの文言（設計 §9.3）。 */
const AUTO_NOT_SUPPORTED_MESSAGE =
  'X（無料版の配信 Plugin）は手動投稿だけに対応しています。deliveryMode に manual を指定してください。\n' +
  '自動で投稿するには、X API の契約と配信 Plugin「X配信（X API）」（sns-x-api）が必要です。';

/**
 * 登録時の事前検査（設計 §9.2 / §9.3）。
 *
 * **5 秒で打ち切られる。外部へ問い合わせない。同期で返す。例外を投げない。**
 * 本文について言うことは必ず `checkXText` から来る。複数の違反はすべて返す。
 */
function validateDraft(post: SocialPostDraftView): PublisherValidationProblem[] {
  const problems: PublisherValidationProblem[] = [];

  // 1：自動配信は届かないので登録の時点で断る。`status` は渡らないので下書きも断る（設計 §11 #1）。
  if (post.deliveryMode === 'auto') {
    problems.push({ field: 'deliveryMode', message: AUTO_NOT_SUPPORTED_MESSAGE });
  }

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

export function createXManualPublisher(): PublisherRegistration {
  return {
    provider: X_PROVIDER,
    label: X_LABEL,
    // 資格情報を 1 つも受け取らない（設計 §5.1）。
    credentialFields: [],
    validate({ post }) {
      return validateDraft(post);
    },
    // Web Intent はブラウザでログイン中のアカウントで開くので、`account` を使わない（設計 §9.5）。
    manual({ post }) {
      return buildXManualHandoff(post);
    },
  };
}
