import type {
  ManualHandoff,
  ManualInput,
  PluginLogger,
  PluginStore,
  PublishInput,
  PublishResult,
  PublisherRegistration,
  PublisherValidationProblem,
  SocialAccountView,
  SocialPostDraftView,
  SocialPostView,
} from '@torifune/plugin-api';
import {
  ACCOUNT_STATE_ERROR_CODES,
  type AtprotoFailure,
  type AtprotoPhase,
  type FetchImpl,
  MEDIA_TOTAL_BUDGET_MS,
  PUBLISH_TOTAL_BUDGET_MS,
  createRecord,
  createSession,
  fetchMedia,
  resolveFetch,
  uploadBlob,
} from './atproto';
import type { PdsUrlResolution } from './settings';
import { resolvePdsUrl } from './settings';
import {
  buildBlueskyIntentUrl,
  detectLinkFacets,
  graphemeCount,
  hasLoneSurrogate,
  MANUAL_URL_MAX_LENGTH,
  manualTextOf,
  utf8ByteLength,
} from './text';

/**
 * Bluesky（AT Protocol）の publisher（036-sns-bluesky 設計 §9）。
 *
 * **Plugin が書くのは「1 回配信する関数」と「投稿画面の URL を返す関数」だけ。**
 * いつ送るか・再試行・記録・画面は Core が持つ。
 */

/** `social_accounts.provider` と同じ値。 */
export const BLUESKY_PROVIDER = 'bluesky';

/** 本文の上限（grapheme）。Bluesky の `app.bsky.feed.post` の `maxGraphemes`。 */
const BODY_MAX_GRAPHEMES = 300;

/** 本文の上限（UTF-8 バイト）。同じ項目の `maxLength`。 */
const BODY_MAX_BYTES = 3000;

/**
 * `alt` の上限（grapheme）。
 *
 * **Bluesky 側の事実ではない。** Core の `MEDIA_ALT_MAX_LENGTH` に数を合わせ、
 * 数え方だけ grapheme に揃えた保守的な値（設計 §9.3 / §11 #11）。
 */
const MEDIA_ALT_MAX_GRAPHEMES = 1000;

/** 1 投稿に添えられる画像の枚数。 */
const MEDIA_MAX = 4;

const LANGS_MAX = 3;
const LANG_MIN_LENGTH = 2;
const LANG_MAX_LENGTH = 16;

/** `providerOptions` で受け付ける唯一のキー。 */
const LANGS_KEY = 'langs';

const MANUAL_NOTE =
  'Bluesky の投稿画面が開きます。内容を確かめて投稿してください。' +
  '画像を添える場合はその画面で添付してください。';

/** 配信済みの投稿を見に行く先。**`bsky.app` 固定**（設計 §6.4 / §11 #3）。 */
const APP_VIEW_URL = 'https://bsky.app';

/** `app.bsky.feed.post` のレコード種別。 */
const POST_COLLECTION = 'app.bsky.feed.post';

/**
 * `externalId` に載せてよい長さ（設計 §6.3）。
 *
 * **Core の `social_posts.external_id` は 200 文字以内**（`migrations/022` の CHECK）で、
 * `publish()` の経路にこの検査は無い。超える値を返すと Core の記録が例外で落ち、
 * **着手印だけが残って投稿は Bluesky に存在する**＝次の周期で二重投稿になる。
 */
const EXTERNAL_ID_MAX_LENGTH = 200;

export interface BlueskyPublisherOptions {
  /** `pds-url` を読むためだけに使う。**資格情報はここへ写さない**（設計 §6.5）。 */
  readonly store: PluginStore;
  /**
   * 外部への HTTP。既定は Node の標準実装（`atproto.ts` の `resolveFetch()` が解決する）。
   *
   * **テストはここを差し替える**（設計 §10.1）。`index.ts` は与えない。
   */
  readonly fetch?: FetchImpl;
  /** `createdAt` に使う時刻。既定は `() => new Date()`（設計 §10.1）。 */
  readonly now?: () => Date;
}

/** 手動投稿で対になっていないサロゲートを見つけたときの文言（042-social-api-input-fixes 設計 §9.2 の 7）。 */
const LONE_SURROGATE_MESSAGE = '本文に扱えない文字が含まれています。';

/** 手動投稿の Web Intent の URL が長すぎるときの文言（042-social-api-input-fixes 設計 §9.2 の 8）。 */
const INTENT_URL_TOO_LONG_MESSAGE = '投稿画面の URL が長くなりすぎます。本文を短くしてください。';

/**
 * 本文として数える文字列。
 *
 * `manual` のときは `body + '\n' + link`（§9.4 で実際に渡す文字列だから）。
 */
function countedBody(post: SocialPostDraftView): string {
  if (post.deliveryMode === 'manual') {
    return manualTextOf(post);
  }
  return typeof post.body === 'string' ? post.body : '';
}

/** `providerOptions.langs` の形（配列・要素は文字列・3 件以内・各 2〜16 文字）。 */
function isValidLangs(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > LANGS_MAX) {
    return false;
  }
  return value.every(
    (item: unknown) =>
      typeof item === 'string' && item.length >= LANG_MIN_LENGTH && item.length <= LANG_MAX_LENGTH,
  );
}

/**
 * 登録時と配信直前の事前検査（設計 §9.3）。
 *
 * **5 秒で打ち切られる。外部へ問い合わせない。例外を投げない。**
 * `providerOptions` は外から来た任意の JSON なので、型を確かめてから触る
 * （循環参照を含みうるので `JSON.stringify` で舐めない）。
 */
function validateDraft(post: SocialPostDraftView): readonly PublisherValidationProblem[] {
  const problems: PublisherValidationProblem[] = [];

  const body = countedBody(post);

  const graphemes = graphemeCount(body);
  if (graphemes > BODY_MAX_GRAPHEMES) {
    problems.push({
      field: 'body',
      message:
        `本文は${BODY_MAX_GRAPHEMES}文字以内にしてください` +
        `（Bluesky は絵文字や結合文字を1文字として数えます）。いまは ${graphemes} 文字です。`,
    });
  }

  if (utf8ByteLength(body) > BODY_MAX_BYTES) {
    problems.push({
      field: 'body',
      message: `本文が長すぎます（Bluesky の上限は${BODY_MAX_BYTES}バイトです）。`,
    });
  }

  // 手動投稿だけ：画面の「投稿画面を開く」で渡す URL を登録時に確かめる
  // （042-social-api-input-fixes 設計 §9.2 の 7・8）。自動配信は Web Intent を使わない。
  if (post.deliveryMode === 'manual') {
    if (hasLoneSurrogate(body)) {
      // 7 に当たったら 8 を数えない（U+FFFD への置き換えで長さが変わり、数えを誤る）。
      problems.push({ field: 'body', message: LONE_SURROGATE_MESSAGE });
    } else if (buildBlueskyIntentUrl(post).length > MANUAL_URL_MAX_LENGTH) {
      // 本文の grapheme 数・バイト数の問題と重ねて返す（違反はすべて返す）。
      problems.push({ field: 'body', message: INTENT_URL_TOO_LONG_MESSAGE });
    }
  }

  const media = Array.isArray(post.media) ? post.media : [];
  media.forEach((item, position) => {
    const alt: unknown = item?.alt;
    if (typeof alt !== 'string') {
      return;
    }
    if (graphemeCount(alt) > MEDIA_ALT_MAX_GRAPHEMES) {
      problems.push({
        field: 'media',
        message: `画像の説明（alt）は${MEDIA_ALT_MAX_GRAPHEMES}文字以内にしてください（${position + 1} 件目）。`,
      });
    }
  });

  const link = typeof post.link === 'string' ? post.link : null;
  if (post.deliveryMode === 'auto' && media.length > 0 && link !== null && link !== '') {
    // **片方を黙って捨てない。** 登録した側は捨てられたことに気づけない（設計 §6.8）。
    problems.push({
      field: 'link',
      message: 'Bluesky は画像とリンクカードを同時に付けられません。リンクは本文に含めてください。',
    });
  }

  const options: unknown = post.providerOptions;
  if (typeof options === 'object' && options !== null && !Array.isArray(options)) {
    for (const key of Object.keys(options)) {
      if (key === LANGS_KEY) {
        if (!isValidLangs((options as Record<string, unknown>)[key])) {
          problems.push({
            field: `providerOptions.${LANGS_KEY}`,
            message: 'langs は言語コードの配列で指定してください（3件まで。例：["ja"]）。',
          });
        }
        continue;
      }
      problems.push({
        field: `providerOptions.${key}`,
        message: `${key} は Bluesky では使いません。`,
      });
    }
  }

  return problems;
}

/* -------------------------------------------------------------------------- */
/* publish()：失敗したときの文言（設計 §6.11）                                   */
/* -------------------------------------------------------------------------- */

const ABORTED_REASON = 'Bluesky への配信が打ち切られました。';

const STORE_REASON = 'Plugin の設定を読み出せませんでした。時間をおいて再試行します。';

const UNEXPECTED_REASON =
  'Bluesky への配信で予期しない問題が起きました。二重投稿を避けるため再試行しません。' +
  'Bluesky 側で投稿を確認してから、必要なら予約し直してください。';

/**
 * App Password の形（041-plugin-help-docs 設計 §6.5.2。ユーザー裁定 U2）。**定義はここ 1 か所。**
 *
 * 英数字 4 文字 × 4 組を `-` で繋いだ 19 文字。根拠（2026-09-24 に確認）は Bluesky の公式の説明
 * （atproto-ecosystem の app-passwords.md の「xxxx-xxxx-xxxx-xxxx」）と、参照実装の PDS の作り方
 * （base32 の 16 文字を 4 文字ずつ繋ぐ）。字母は写し間違いと自前の PDS を考えて英数字（大文字を含む）に広げた。
 * 参照実装以外の PDS がすべてこの形で作ることは確かめられなかった（設計 §11.2 #12）。
 */
const APP_PASSWORD_PATTERN = /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/;

/**
 * App Password の形でない値を送らずに止めたときの文言（設計 §6.5.3）。
 *
 * `createSession` はアカウントのパスワードも受け付け、全権限のセッションになる。
 * **入れた値・長さ・どこが違うかを載せない。**
 */
const APP_PASSWORD_SHAPE_REASON =
  'App Password（アプリパスワード）の形ではありません。ログイン用のパスワードは送らずに止めました。' +
  'Bluesky の「設定 → プライバシーとセキュリティ → アプリパスワード」で発行した xxxx-xxxx-xxxx-xxxx の形の値を、' +
  '「資格情報を設定」から入れてください。';

const EMBED_CONFLICT_REASON =
  'Bluesky は画像とリンクカードを同時に付けられません。どちらかを外して登録し直してください。';

function configReason(problem: string): string {
  return `PDS の URL の設定が正しくありません（${problem}）。Plugin の設定画面で直してください。`;
}

/**
 * `reason` に載せる応答の素性。
 *
 * **HTTP の status と、既知の `error` コードだけ。** PDS が返した `message`（自由文）は
 * 載せない。Core の伏せ字は4文字以上の完全一致しか消せないので、**伏せ字を当てにしない**（設計 §6.11）。
 */
function detailOf(failure: AtprotoFailure): string {
  if (failure.status === undefined) {
    return '';
  }
  return failure.code === undefined
    ? `（${failure.status}）`
    : `（${failure.status} ${failure.code}）`;
}

function sessionReason(failure: AtprotoFailure, detail: string): string {
  if (failure.kind === 'network' || failure.kind === 'timeout') {
    return 'Bluesky（PDS）へ接続できませんでした。時間をおいて再試行します。';
  }
  if (failure.kind === 'shape') {
    return 'Bluesky（PDS）の応答を解釈できませんでした。時間をおいて再試行します。';
  }

  const code = failure.code;
  const status = failure.status ?? 0;
  if (code !== undefined && ACCOUNT_STATE_ERROR_CODES.has(code)) {
    return `Bluesky のアカウントが利用できません${detail}。Bluesky 側でアカウントの状態を確認してください。`;
  }
  if (status === 429) {
    return `Bluesky へのログインが集中しています${detail}。時間をおいて再試行します。`;
  }
  if (status === 401 || code === 'AuthFactorTokenRequired') {
    return (
      `Bluesky へのログインに失敗しました${detail}。App Password を確認してください` +
      '（取り消されていないか、写し間違いがないか）。'
    );
  }
  if (status >= 500) {
    return `Bluesky（PDS）が応答できませんでした${detail}。時間をおいて再試行します。`;
  }
  return `Bluesky へのログインを断られました${detail}。PDS の URL と App Password を確認してください。`;
}

/**
 * 媒体の失敗の文言（設計 §6.11）。
 *
 * **`detailOf` を使わない。HTTP の status を外へ出さない。**
 * 取得先は `social.write` を持つ誰かが書いた任意の URL であり（設計 §8.2）、
 * この文言は `social_posts.failure_reason` に保存されて **`social.read` で読める。**
 * status を載せると、**投稿を1件ずつ積むだけで内部ホストの生死と応答の別を列挙できる。**
 *
 * 残す粒度は「**一時的な失敗**」か「**`media[].url` を直す必要がある失敗**」かの二分まで。
 * **`retryable` の判断には status を使い続ける**（判断に使うことと外へ出すことは別）。
 */
function mediaReason(failure: AtprotoFailure): string {
  switch (failure.kind) {
    case 'redirect':
      return '画像の URL が転送されています。転送先の URL を直接指定してください。';
    case 'contentType':
      return '画像ではないファイルが返されました。PNG・JPEG・GIF・WebP の URL を指定してください。';
    case 'tooLarge':
      return '画像が大きすぎます（1MB まで）。小さい画像を指定してください。';
    case 'budget':
      return '画像の取得に時間がかかりすぎました。時間をおいて再試行します。';
    case 'http':
      return failure.retryable
        ? '画像を取得できませんでした。時間をおいて再試行します。'
        : '画像を取得できませんでした。画像の URL が公開されているか確認してください。';
    default:
      return '画像を取得できませんでした。時間をおいて再試行します。';
  }
}

function uploadReason(failure: AtprotoFailure, detail: string): string {
  if (failure.kind !== 'http') {
    return 'Bluesky へ画像をアップロードできませんでした。時間をおいて再試行します。';
  }
  const status = failure.status ?? 0;
  if (status === 401) {
    return `Bluesky が画像のアップロードを断りました${detail}。App Password を確認してください。`;
  }
  if (status === 429 || status >= 500) {
    return `Bluesky へ画像をアップロードできませんでした${detail}。時間をおいて再試行します。`;
  }
  return `Bluesky が画像を受け付けませんでした${detail}。画像の大きさ（1MB まで）と形式を確認してください。`;
}

function recordReason(failure: AtprotoFailure, detail: string): string {
  const status = failure.status ?? 0;
  if (status === 429) {
    return `Bluesky への投稿が集中しています${detail}。時間をおいて再試行します。`;
  }
  if (status === 401) {
    return (
      `Bluesky の認証が配信の途中で切れました${detail}。` +
      '二重投稿を避けるため再試行しません。Bluesky 側で投稿を確認してから、必要なら予約し直してください。'
    );
  }
  return (
    `Bluesky へ投稿が届いたかを確認できませんでした${detail}。` +
    '二重投稿を避けるため再試行しません。Bluesky 側で投稿を確認してから、必要なら予約し直してください。'
  );
}

/** **運用者が次に何をすればよいかが読める日本語**にする（設計 §6.11）。 */
function reasonFor(failure: AtprotoFailure): string {
  switch (failure.phase) {
    case 'createSession':
      return sessionReason(failure, detailOf(failure));
    case 'media':
      // **媒体だけは `detailOf` を渡さない**（設計 §6.11）。
      return mediaReason(failure);
    case 'uploadBlob':
      return uploadReason(failure, detailOf(failure));
    case 'createRecord':
      return recordReason(failure, detailOf(failure));
    default:
      return `Bluesky への配信に失敗しました${detailOf(failure)}。`;
  }
}

/* -------------------------------------------------------------------------- */
/* publish()：record の組み立て（設計 §6.3 / §6.7 / §6.8）                       */
/* -------------------------------------------------------------------------- */

/** 本文に添える URL。空文字は「無し」と同じに扱う。 */
function linkOf(post: SocialPostView): string | null {
  return typeof post.link === 'string' && post.link !== '' ? post.link : null;
}

/** リンクカードの見出し。**OGP を取りに行かない**（設計 §6.8）。 */
function hostnameOf(link: string): string {
  try {
    return new URL(link).hostname;
  } catch {
    return '';
  }
}

/** `record.langs` に入れる値。無ければ `null`（キーごと入れない）。 */
function langsOf(post: SocialPostView): readonly string[] | null {
  const options: unknown = post.providerOptions;
  if (typeof options !== 'object' || options === null) {
    return null;
  }
  const value: unknown = (options as Record<string, unknown>)[LANGS_KEY];
  if (!isValidLangs(value) || (value as readonly string[]).length === 0) {
    return null;
  }
  return value as readonly string[];
}

/* -------------------------------------------------------------------------- */
/* publish()（設計 §6）                                                         */
/* -------------------------------------------------------------------------- */

/**
 * 1回配信する。
 *
 * **例外を投げない。** 投げると Core は常に「結果不明」として `failed` にし、再試行しない。
 * `createRecord` より前の失敗まで `failed` になるのは損である（設計 §6.11）。
 *
 * **`logger` へ渡すのは `postId` / `attempt` / フェーズ名 / HTTP status / 媒体の件数だけ。**
 * `credential`・`accessJwt`・`post.body`・`handle` を渡さない。
 */
async function publishPost(
  options: BlueskyPublisherOptions,
  input: PublishInput,
): Promise<PublishResult> {
  const { post, credential, attempt, signal, logger } = input;

  try {
    if (signal.aborted) {
      // Core は既に「結果不明」として確定させている。何を返しても記録されない（設計 §6.6）。
      return { ok: false, reason: ABORTED_REASON, retryable: false };
    }

    const media = post.media;
    logger.info('Bluesky へ配信する', { postId: post.id, attempt, mediaCount: media.length });

    // **この Plugin が見る時計**（設計 §10.1）。期限の「いま」もここから取る。
    const clock = options.now ?? ((): Date => new Date());
    const startedAt = clock().getTime();

    /**
     * `publish()` 全体の期限（設計 §6.6）。
     *
     * **要求ごとの制限時間だけでは合計を縛れない**（10 ＋ 20 ＋ 15 は Core の 30 秒を超える）。
     * すべての要求はこの signal を外側に持つ。
     */
    const totalDeadline = startedAt + PUBLISH_TOTAL_BUDGET_MS;
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(PUBLISH_TOTAL_BUDGET_MS)]);

    /**
     * 失敗をログに残す。
     *
     * **`media` フェーズだけ `status` を落とす**（設計 §6.11）。取得先は利用者が指した任意の URL で、
     * ログは `system.manage` で読める。`createSession` / `uploadBlob` / `createRecord` の status は
     * **運用者が自分で設定した PDS の応答**なので、そのまま残す。
     */
    const warn = (phase: AtprotoPhase, status?: number): void => {
      logger.warn('Bluesky への配信に失敗した', {
        postId: post.id,
        attempt,
        phase,
        ...(phase === 'media' || status === undefined ? {} : { status }),
        mediaCount: media.length,
      });
    };

    const fail = (failure: AtprotoFailure): PublishResult => {
      warn(failure.phase, failure.status);
      const result = {
        ok: false as const,
        reason: reasonFor(failure),
        retryable: failure.retryable,
      };
      return failure.retryAfterMs === undefined
        ? result
        : { ...result, retryAfterMs: failure.retryAfterMs };
    };

    // **毎回読む。** `activate()` の時点で閉じ込めると、設定を変えても再起動するまで効かない。
    let resolution: PdsUrlResolution;
    try {
      resolution = await resolvePdsUrl(options.store);
    } catch {
      // まだ何も送っていない（設計 §6.9 の P0）。
      logger.warn('Plugin の設定を読み出せなかった', { postId: post.id, attempt, phase: 'config' });
      return { ok: false, reason: STORE_REASON, retryable: true };
    }
    if (!resolution.ok) {
      // 人が設定を直すまで直らない。**`fetch` を1度も呼ばない。**
      logger.warn('PDS の URL の設定が不正', { postId: post.id, attempt, phase: 'config' });
      return { ok: false, reason: configReason(resolution.reason), retryable: false };
    }
    const pdsUrl = resolution.url;

    // **App Password の形でない値は Bluesky へ送らない**（041 設計 §6.5。ユーザー裁定 U2）。
    // ログイン用のパスワードでも `createSession` は通り、全権限のセッションになるため。
    // 人が直すまで直らない。**`fetch` を1度も呼ばない。値・長さ・どこが違うかをログに載せない。**
    if (!APP_PASSWORD_PATTERN.test(credential['appPassword'] ?? '')) {
      logger.warn('app password shape rejected', { postId: post.id, attempt, phase: 'credential' });
      return { ok: false, reason: APP_PASSWORD_SHAPE_REASON, retryable: false };
    }

    // **`embed` は1つしか持てない。** 片方を黙って捨てない（設計 §6.8）。
    const link = linkOf(post);
    if (media.length > 0 && link !== null) {
      // **早期 return でもログを残す**（設計 §6.8）。`fail()` を通らないので明示的に呼ぶ。
      warn('embed');
      return { ok: false, reason: EMBED_CONFLICT_REASON, retryable: false };
    }

    const impl = resolveFetch(options.fetch);

    // **`publish()` 1回につき `createSession` 1回。`refreshJwt` は捨てる**（設計 §6.5）。
    const session = await createSession({
      impl,
      pdsUrl,
      identifier: credential['identifier'] ?? '',
      password: credential['appPassword'] ?? '',
      signal: deadline,
    });
    if (!session.ok) {
      return fail(session.failure);
    }
    const { did, handle, accessJwt } = session.value;

    // **媒体は1件ずつ順に処理する。** 並行に取りに行くと相手側の Rate Limit を自分で踏む（設計 §6.6）。
    const images: { readonly image: unknown; readonly alt: string }[] = [];
    // **`createSession` の後の残り時間から取る**（合計の期限を超えない。設計 §6.6）。
    const mediaDeadline = Math.min(clock().getTime() + MEDIA_TOTAL_BUDGET_MS, totalDeadline);
    for (const item of media) {
      if (clock().getTime() > mediaDeadline) {
        // まだ `createRecord` を呼んでいないので、諦めても投稿は作られていない。
        return fail({ phase: 'media', kind: 'budget', retryable: true });
      }
      const fetched = await fetchMedia({ impl, url: item.url, signal: deadline });
      if (!fetched.ok) {
        return fail(fetched.failure);
      }
      const uploaded = await uploadBlob({
        impl,
        pdsUrl,
        accessJwt,
        media: fetched.value,
        signal: deadline,
      });
      if (!uploaded.ok) {
        return fail(uploaded.failure);
      }
      images.push({ image: uploaded.value, alt: item.alt ?? '' });
    }

    const record: Record<string, unknown> = {
      $type: POST_COLLECTION,
      text: post.body,
      // **実際に送った時刻。** `post.scheduledAt` は使わない（設計 §6.3）。
      createdAt: clock().toISOString(),
    };

    const langs = langsOf(post);
    if (langs !== null) {
      record['langs'] = langs;
    }

    // **Bluesky は本文の URL を自動ではリンクにしない**（設計 §6.7）。見つからなければ付けない。
    const facets = detectLinkFacets(post.body);
    if (facets.length > 0) {
      record['facets'] = facets;
    }

    if (images.length > 0) {
      record['embed'] = { $type: 'app.bsky.embed.images', images };
    } else if (link !== null) {
      record['embed'] = {
        $type: 'app.bsky.embed.external',
        external: { uri: link, title: hostnameOf(link), description: '' },
      };
    }

    const created = await createRecord({
      impl,
      pdsUrl,
      accessJwt,
      body: { repo: did, collection: POST_COLLECTION, record },
      signal: deadline,
    });
    if (!created.ok) {
      return fail(created.failure);
    }

    logger.info('Bluesky へ配信した', { postId: post.id, attempt, mediaCount: media.length });

    const rkey = created.value.rkey;
    if (rkey.length > EXTERNAL_ID_MAX_LENGTH) {
      // **失敗にしない。投稿は作られている**（`createRecord` は 200 を返した）。
      // 失敗にすると再試行で二重投稿になる。`externalUrl` も rkey を含むので、片方だけ残さない（設計 §6.3）。
      logger.warn('Bluesky の投稿の識別子が長すぎて記録できない', {
        postId: post.id,
        attempt,
        phase: 'createRecord',
        mediaCount: media.length,
      });
      return { ok: true };
    }

    return {
      ok: true,
      externalId: rkey,
      // **外から来た文字列をそのまま URL へ差し込まない**（設計 §6.4）。
      externalUrl: `${APP_VIEW_URL}/profile/${encodeURIComponent(handle)}/post/${encodeURIComponent(rkey)}`,
      // **`rotatedCredential` は返さない。** App Password は固定である（設計 §6.5）。
    };
  } catch {
    // **分類できなければ `false`**（設計 §6.9 の「どこでも」）。
    safeError(logger, post.id, attempt);
    return { ok: false, reason: UNEXPECTED_REASON, retryable: false };
  }
}

/** 失敗の記録そのもので `publish()` が投げないようにする。 */
function safeError(logger: PluginLogger, postId: string, attempt: number): void {
  try {
    logger.error('Bluesky への配信で予期しない問題が起きた', { postId, attempt });
  } catch {
    // ログが出せないことを理由に例外を投げない。
  }
}

/**
 * Bluesky の publisher を組み立てる。
 *
 * `store` は `pds-url` を読むためだけに渡す（設計 §10.1）。
 */
export function createBlueskyPublisher(options: BlueskyPublisherOptions): PublisherRegistration {
  return {
    provider: BLUESKY_PROVIDER,
    label: 'Bluesky',

    /**
     * 資格情報の形。**入力欄と形式検証は Core が持つ。**
     *
     * **この2つで確定。** 後から項目を足すと、登録済みのアカウントの投稿が
     * すべて `failed` になる（設計 §5.2）。
     */
    credentialFields: [
      {
        key: 'identifier',
        label: 'ハンドルまたはメールアドレス',
        description: 'Bluesky のハンドル（例：example.bsky.social）。先頭の @ は書かない。',
        kind: 'text',
        placeholder: 'example.bsky.social',
      },
      {
        key: 'appPassword',
        label: 'App Password（アプリパスワード）',
        description:
          'Bluesky にログインするパスワードではありません。Bluesky の「設定 → プライバシーとセキュリティ → アプリパスワード」で発行した、xxxx-xxxx-xxxx-xxxx の形（英数字 4 文字を 4 組、ハイフンで繋ぐ）の文字列を入れます。' +
          'ログイン用のパスワードは入れないでください（この形でない値は Bluesky へ送らずに止めます）。App Password はいつでも個別に取り消せます。保存後は再表示されません。',
        kind: 'secret',
      },
    ],

    /**
     * 粗い上限。
     *
     * **`bodyMaxLength` を 300 にしない。** Core は `post.body.length`（UTF-16 の
     * 要素数）で数えるので、300 にすると Bluesky が受け付ける投稿を 422 で弾く。
     * 厳密な 300 grapheme は `validate()` が見る（設計 §9.2）。
     */
    limits: { bodyMaxLength: BODY_MAX_BYTES, mediaMax: MEDIA_MAX },

    validate(input: {
      readonly post: SocialPostDraftView;
      readonly account: SocialAccountView;
    }): readonly PublisherValidationProblem[] {
      // **同期で返す。** Promise を返すと 5 秒の打ち切りに近づくだけで得が無い。
      return validateDraft(input.post);
    },

    async publish(input: PublishInput): Promise<PublishResult> {
      // **例外を投げない。** すべての経路を `try` で包み、`PublishResult` として返す（設計 §6.11）。
      return await publishPost(options, input);
    },

    manual(input: ManualInput): ManualHandoff {
      // **`store` を読まない・`await` しない・例外を投げない。**
      // 2 秒で打ち切られ、1 画面で最大 50 行ぶん呼ばれる（設計 §9.4）。
      // URL は validate() が数えたものと同じ関数で組み立てる（042-social-api-input-fixes 設計 §9.2）。
      return { url: buildBlueskyIntentUrl(input.post), note: MANUAL_NOTE };
    },
  };
}
