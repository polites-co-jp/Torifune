import type {
  PluginLogger,
  PluginSettingsField,
  PublishInput,
  PublishResult,
  PublisherLimits,
  PublisherRegistration,
  PublisherValidationProblem,
  SocialMediaView,
  SocialPostDraftView,
} from '@torifune/plugin-api';
import { buildOAuth1Header, type OAuth1Credential } from './oauth1';
import {
  X_WEIGHTED_LENGTH_MAX,
  buildXManualHandoff,
  checkXText,
  composeXText,
  countXWeightedLength,
} from './x-text';
import {
  CREATE_TWEET_TIMEOUT_MS,
  CREATE_TWEET_URL,
  MEDIA_BUDGET_MS,
  MEDIA_UPLOAD_URL,
  PUBLISH_TOTAL_BUDGET_MS,
  budgetFailure,
  createTweet,
  fetchImage,
  isValidCredentialValue,
  resolveFetch,
  uploadMedia,
  type FetchImpl,
  type XFailure,
  type XPhase,
} from './xapi';

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

/** 1 投稿の画像の上限（X の上限。設計 §6.1）。`publish()` の入口（P0）も同じ値で見る。 */
const MEDIA_MAX = 4;

/**
 * Core が登録時と配信直前に適用する制約（設計 §9.1）。
 *
 * **`bodyMaxLength` を宣言しない。** URL は長さによらず 23 と数えるので、Core の `String.length` に対して
 * 必ず緩い側になる有限の値が無い。本文の判定は `validate()`（`checkXText`）が行う。
 */
const LIMITS: PublisherLimits = { mediaMax: MEDIA_MAX };

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

/* -------------------------------------------------------------------------- */
/* publish()：既定の時計と nonce（設計 §6.3 / §10.1）                             */
/* -------------------------------------------------------------------------- */

/** 既定の時計。 */
function defaultNow(): Date {
  return new Date();
}

/** 既定の nonce のバイト数。16 進にすると 64 文字。 */
const NONCE_BYTES = 32;

/** 既定の nonce。暗号論的な乱数の 32 バイトを 16 進にしたもの（設計 §6.3）。 */
function defaultNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* -------------------------------------------------------------------------- */
/* publish()：失敗したときの文言（設計 §6.9）                                     */
/* -------------------------------------------------------------------------- */

const ABORTED_REASON = 'X への配信が打ち切られました。';

const CREDENTIAL_REASON =
  'X API の資格情報の形が正しくありません（4 つの値はどれも、空白・改行・全角文字を含まない 256 文字以内の文字列です）。' +
  'SNS アカウントの資格情報を登録し直してください。';

const MEDIA_COUNT_REASON = `X の投稿に付けられる画像は${MEDIA_MAX}枚までです。画像を減らして登録し直してください。`;

const BODY_REASON =
  `X の本文が長すぎます（重み付きで${X_WEIGHTED_LENGTH_MAX}を超えています）。` +
  '本文を短くして登録し直してください。';

const NOT_CONFIRMED_SUFFIX =
  '二重投稿を避けるため再試行しません。X 側で投稿を確認してから、必要なら予約し直してください。';

const UNEXPECTED_BEFORE_CREATE_REASON =
  'X への配信の準備中に予期しない問題が起きました。投稿の要求は送っていないので、時間をおいて再試行します。';

const UNEXPECTED_AFTER_CREATE_REASON = `X へ投稿の要求を送った後で予期しない問題が起きました。${NOT_CONFIRMED_SUFFIX}`;

const AUTH_GUIDE =
  'API Key・Access Token とそれぞれの Secret を確かめてください。サーバの時計がずれていても起きます。';

/**
 * R1（画像の取得）の失敗。**HTTP の status を載せない。** 載せてよいのは「一時的か、URL を直す必要があるか」の二分だけ
 * （取得先の status を反射すると、`social.write` を持つ者が内部ネットワークを走査できる。設計 §6.5 / 036 中-1）。
 */
function mediaReason(failure: XFailure): string {
  if (failure.kind === 'budget') {
    return '画像の処理が時間内に終わりませんでした。時間をおいて再試行します。';
  }
  return failure.retryable
    ? '画像を取得できませんでした（一時的な失敗）。再試行します。'
    : '画像を取得できませんでした。media の URL が、インターネットから取得できる 5MB 以下の' +
        ' JPEG・PNG・WebP 画像を指しているか確かめてください（転送は追いません）。';
}

/** R2 / R3 の失敗に添える素性。**フェーズの言葉と HTTP の status だけ**（設計 §6.9）。 */
function detailOf(label: string, failure: XFailure): string {
  return failure.status === undefined
    ? `（${label}）`
    : `（${label}、HTTP ${String(failure.status)}）`;
}

/** R2（画像のアップロード）の失敗。**R3 は送っていない。** */
function uploadReason(failure: XFailure): string {
  const detail = detailOf('画像のアップロード', failure);
  switch (failure.kind) {
    case 'network':
    case 'timeout':
    case 'aborted':
      return `X API へ接続できませんでした${detail}。時間をおいて再試行します。`;
    case 'processing':
      return `X が画像の処理を終えていませんでした${detail}。時間をおいて再試行します。`;
    case 'http':
      break;
    default:
      return `X API の応答を解釈できませんでした${detail}。時間をおいて再試行します。`;
  }
  const status = failure.status ?? 0;
  if (status === 429) {
    return `X API の呼び出し回数の制限に達しました${detail}。時間をおいて再試行します。`;
  }
  if (status === 401) {
    return `X API の認証に失敗しました${detail}。${AUTH_GUIDE}`;
  }
  if (status === 403) {
    return (
      `X が画像のアップロードを受け付けませんでした${detail}。` +
      'アプリの権限（Read and write）と、X API のクレジットの残高を確かめてください。'
    );
  }
  if (status >= 300 && status < 400) {
    return `X API が想定しない転送を返しました${detail}。転送は追いません。`;
  }
  if (status >= 500) {
    return `X API が一時的に応答できませんでした${detail}。時間をおいて再試行します。`;
  }
  return `X が画像を受け付けませんでした${detail}。画像の内容を確かめてください。`;
}

/** R3（投稿）の失敗。**送った後は、429 のほかは届いたか分からない。** */
function createReason(failure: XFailure): string {
  const detail = detailOf('投稿', failure);
  if (failure.kind !== 'http') {
    // 接続断・制限時間・本体が読めない・`data.id` が無い。
    return `X へ投稿の要求が届いたかを確認できませんでした${detail}。${NOT_CONFIRMED_SUFFIX}`;
  }
  const status = failure.status ?? 0;
  if (status === 429) {
    return `X API の呼び出し回数の制限に達しました${detail}。時間をおいて再試行します。`;
  }
  if (status === 401) {
    return `X API の認証に失敗しました${detail}。${AUTH_GUIDE}`;
  }
  if (status === 403) {
    // 重複した内容・権限・クレジットを区別しない（X の自由文を読まない。設計 §6.9 / §11 #8）。
    return (
      `X が投稿を受け付けませんでした${detail}。同じ内容の連投、アプリの権限（Read and write）、` +
      'X API のクレジットの残高を確かめてください。'
    );
  }
  if (status >= 300 && status < 400) {
    return `X API が想定しない転送を返しました${detail}。転送は追いません。${NOT_CONFIRMED_SUFFIX}`;
  }
  if (status >= 500) {
    return `X API が投稿の要求に正常に応答しませんでした${detail}。${NOT_CONFIRMED_SUFFIX}`;
  }
  return `X が投稿の要求を受け付けませんでした${detail}。${NOT_CONFIRMED_SUFFIX}`;
}

/**
 * `reason` の文言。**運用者が次に何をすればよいかが読める日本語**にする。
 *
 * 載せてよいのは固定の日本語・R2 / R3 の HTTP の status・固定の案内文だけ（設計 §6.9）。
 * X API の応答の `title` / `detail` / `type` / `errors`・ヘッダの値・要求の URL・例外の文面は載せない。
 * Core の伏せ字は 4 文字以上の完全一致しか消せないので、**伏せ字を当てにせず、読まない。**
 */
function reasonFor(failure: XFailure): string {
  switch (failure.phase) {
    case 'media':
      return mediaReason(failure);
    case 'upload':
      return uploadReason(failure);
    case 'prepare':
      return '投稿の要求を送るだけの時間が残っていなかったため、送らずに中断しました。時間をおいて再試行します。';
    case 'create':
      return createReason(failure);
  }
}

/* -------------------------------------------------------------------------- */
/* publish()：段取り（設計 §6.4〜§6.8）                                           */
/* -------------------------------------------------------------------------- */

/** ログの `phase`（実装プラン §8 の 6）。`input` は入口（P0）。 */
type LogPhase = 'input' | XPhase;

/** ログが投げても `publish()` を投げさせない。 */
function safeLogger(logger: PluginLogger): PluginLogger {
  const guard =
    (method: keyof PluginLogger) =>
    (message: string, detail?: Record<string, unknown>): void => {
      try {
        logger[method](message, detail);
      } catch {
        // ログが出せないことを理由に例外を投げない。
      }
    };
  return { debug: guard('debug'), info: guard('info'), warn: guard('warn'), error: guard('error') };
}

/**
 * 資格情報の 4 値を取り出す。1 つでも §6.9 の形に合わなければ `undefined`（外へ 1 本も出さない）。
 *
 * **`...credential` で写さない。** 使うキーだけを明示して組む。
 */
function readCredential(
  credential: Readonly<Record<string, string>>,
): OAuth1Credential | undefined {
  const apiKey = credential['apiKey'];
  const apiKeySecret = credential['apiKeySecret'];
  const accessToken = credential['accessToken'];
  const accessTokenSecret = credential['accessTokenSecret'];
  if (
    !isValidCredentialValue(apiKey) ||
    !isValidCredentialValue(apiKeySecret) ||
    !isValidCredentialValue(accessToken) ||
    !isValidCredentialValue(accessTokenSecret)
  ) {
    return undefined;
  }
  return { apiKey, apiKeySecret, accessToken, accessTokenSecret };
}

/** 投稿 ID から投稿の URL を作る。ハンドルを使わない（設計 §6.7）。**形の検査を通した ID だけを渡す。** */
function statusUrlOf(tweetId: string): string {
  return `https://x.com/i/status/${tweetId}`;
}

/**
 * 1 回配信する。
 *
 * **例外を投げない。** すべての経路を `try` で包み、`PublishResult` として返す（設計 §6.9）。
 * **「R3 を送ったか」を 1 つの変数で持ち**、予期しない例外の分類はそれで決める（設計 §6.8 の「どこでも」）。
 *
 * ログに渡すのは `postId` / `attempt` / `phase` / 画像の件数と何件目か / R2・R3 の status だけ。
 * 資格情報・本文・`link`・`media[].url`・媒体の ID・投稿の ID・ヘッダ・ハンドルは渡さない（設計 §6.9）。
 */
async function publishPost(
  options: XApiPublisherOptions,
  input: PublishInput,
): Promise<PublishResult> {
  const { post, attempt, signal } = input;
  const logger = safeLogger(input.logger);
  const media: readonly SocialMediaView[] = Array.isArray(post.media) ? post.media : [];
  const base = { postId: post.id, attempt, mediaCount: media.length };
  /** いまどの段階か。予期しない例外のログはこれを使う。 */
  let phase: LogPhase = 'input';
  /** R3 を送ったか（送ろうとしたか）。**予期しない例外の `retryable` はこれで決める。** */
  let createSent = false;

  try {
    if (signal.aborted) {
      // Core は既に「結果不明」として確定させている。何を返しても記録されない（設計 §6.6）。
      return { ok: false, reason: ABORTED_REASON, retryable: false };
    }
    logger.info('X へ配信する', base);

    // P0：外へ 1 本も出さずに断る。人が直すまで直らない（設計 §6.8）。
    const rejectInput = (reason: string): PublishResult => {
      logger.warn('x input rejected', { ...base, phase });
      return { ok: false, reason, retryable: false };
    };
    const credential = readCredential(input.credential);
    if (credential === undefined) {
      return rejectInput(CREDENTIAL_REASON);
    }
    if (media.length > MEDIA_MAX) {
      return rejectInput(MEDIA_COUNT_REASON);
    }
    // 送れば 400 で断られるだけの要求に料金を払わない。数えるのは送る文字列そのもの。
    const text = composeXText(post);
    if (countXWeightedLength(text) > X_WEIGHTED_LENGTH_MAX) {
      return rejectInput(BODY_REASON);
    }

    const impl: FetchImpl = resolveFetch(options.fetch);
    const clock = options.now ?? defaultNow;
    const nonce = options.nonce ?? defaultNonce;
    const nowMs = (): number => clock().getTime();
    // **期限の判定は `now()` で数える**（実時間の打ち切りは `AbortSignal.timeout` が別に効く。設計 §6.6）。
    const startedAt = nowMs();
    const elapsedMs = (): number => nowMs() - startedAt;
    // **入口で合計の期限を 1 つ作り、すべての要求の外側に混ぜる**（036 R-2）。
    const outer = AbortSignal.any([signal, AbortSignal.timeout(PUBLISH_TOTAL_BUDGET_MS)]);

    /** R2 / R3 の `Authorization`。本体は署名に含めない（`params: {}`。設計 §6.3）。 */
    const authorize = async (url: string): Promise<string> =>
      await buildOAuth1Header({
        method: 'POST',
        url,
        params: {},
        credential,
        nonce: nonce(),
        timestamp: Math.floor(nowMs() / 1000),
      });

    const fail = (failure: XFailure, mediaIndex?: number): PublishResult => {
      if (signal.aborted) {
        return { ok: false, reason: ABORTED_REASON, retryable: false };
      }
      logger.warn('x publish failed', {
        ...base,
        phase: failure.phase,
        ...(mediaIndex === undefined ? {} : { mediaIndex }),
        ...(failure.status === undefined ? {} : { status: failure.status }),
      });
      return {
        ok: false,
        reason: reasonFor(failure),
        retryable: failure.retryable,
        ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
      };
    };

    // R1 → R2 を 1 件ずつ順に（相手側の Rate Limit を自分で踏まない。設計 §6.5）。
    const mediaIds: string[] = [];
    if (media.length > 0) {
      // 画像の処理は合計の期限に画像の期限を混ぜた signal の下で行う（実装プラン §8 の 5）。
      const mediaSignal = AbortSignal.any([outer, AbortSignal.timeout(MEDIA_BUDGET_MS)]);
      for (const [index, item] of media.entries()) {
        phase = 'media';
        if (elapsedMs() >= MEDIA_BUDGET_MS) {
          // 残りの画像を取りに行かない。R3 を送っていない。
          return fail(budgetFailure('media'), index);
        }
        const image = await fetchImage({ impl, url: item.url, signal: mediaSignal });
        if (!image.ok) {
          return fail(image.failure, index);
        }

        phase = 'upload';
        const uploaded = await uploadMedia({
          impl,
          image: image.value,
          authorization: await authorize(MEDIA_UPLOAD_URL),
          signal: mediaSignal,
          nowMs,
        });
        if (!uploaded.ok) {
          return fail(uploaded.failure, index);
        }
        // **形の検査を通した ID だけを積む**（`uploadMedia` が `^[0-9]{1,20}$` を見ている）。
        mediaIds.push(uploaded.value);
      }
    }

    // **途中で切られる見込みの R3 は始めない。** 打ち切られた R3 は「届いたか分からない」になる（設計 §6.4）。
    phase = 'prepare';
    if (PUBLISH_TOTAL_BUDGET_MS - elapsedMs() < CREATE_TWEET_TIMEOUT_MS) {
      return fail(budgetFailure('prepare'));
    }

    phase = 'create';
    const authorization = await authorize(CREATE_TWEET_URL);
    createSent = true;
    // **R3 は画像の signal ではなく外側の signal の下で送る**（画像の期限で投稿の要求を切らない。設計 §6.6）。
    const created = await createTweet({
      impl,
      text,
      mediaIds,
      authorization,
      signal: outer,
      nowMs,
    });
    if (!created.ok) {
      return fail(created.failure);
    }
    logger.info('X へ配信した', base);

    const { tweetId } = created.value;
    if (tweetId === undefined) {
      // **失敗にしない。** 201 と `id` が返った以上、投稿はある。再試行すると二重投稿になる（設計 §6.7）。
      logger.warn('x tweet id rejected', { ...base, phase });
      return { ok: true };
    }
    return { ok: true, externalId: tweetId, externalUrl: statusUrlOf(tweetId) };
  } catch {
    // 送っていなければ `true`、送っていれば・分からなければ `false`（設計 §6.8 の「どこでも」）。
    //
    // **`createSent === true` の側は防御的なコード**であり、現状のコードでは到達する経路が無い。
    // R3 を送った後に呼ぶのは `createTweet`（`sendXRequest` と本体の読み込みが例外を投げずに分類する）・
    // `fail`・`safeLogger` を通したログ・戻り値の組み立てだけで、どれもここへ例外を落とさない。
    // 後から R3 の後に処理を足しても二重投稿へ倒れないよう、分岐は残す。**テストで到達を確かめたものではない。**
    logger.error('x publish unexpected', { ...base, phase });
    return createSent
      ? { ok: false, reason: UNEXPECTED_AFTER_CREATE_REASON, retryable: false }
      : { ok: false, reason: UNEXPECTED_BEFORE_CREATE_REASON, retryable: true };
  }
}

/**
 * X API の publisher を組み立てる。
 *
 * **状態を 1 つも持たない**ので、Key-Value Store を受け取らない（設計 §5.3）。
 * `index.ts` は引数を与えない。差し替えるのはテストだけ（設計 §10.1）。
 */
export function createXApiPublisher(options: XApiPublisherOptions = {}): PublisherRegistration {
  return {
    provider: X_PROVIDER,
    label: X_LABEL,
    credentialFields: CREDENTIAL_FIELDS,
    limits: LIMITS,
    validate({ post }) {
      return validateDraft(post);
    },
    // **例外を投げない。** すべての経路を `try` で包み、`PublishResult` として返す（設計 §6.9）。
    publish: async (input) => await publishPost(options, input),
    // Web Intent はブラウザでログイン中のアカウントで開くので、`account` を使わない（設計 §9.5）。
    manual({ post }) {
      return buildXManualHandoff(post);
    },
  };
}
