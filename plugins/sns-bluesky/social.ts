import type {
  ManualHandoff,
  ManualInput,
  PluginStore,
  PublisherRegistration,
  PublisherValidationProblem,
  SocialAccountView,
  SocialPostDraftView,
} from '@torifune/plugin-api';
import { graphemeCount, utf8ByteLength } from './text';

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

/** 手動投稿の受け皿。**PDS の設定と関係がない**（設計 §7.1）。 */
const MANUAL_INTENT_URL = 'https://bsky.app/intent/compose';

const MANUAL_NOTE =
  'Bluesky の投稿画面が開きます。内容を確かめて投稿してください。' +
  '画像を添える場合はその画面で添付してください。';

export interface BlueskyPublisherOptions {
  /** `pds-url` を読むためだけに使う。**資格情報はここへ写さない**（設計 §6.5）。 */
  readonly store: PluginStore;
}

/** `deliveryMode: 'manual'` で実際に投稿画面へ渡す文字列。 */
function manualText(body: string, link: string | null): string {
  return link === null || link === '' ? body : `${body}\n${link}`;
}

/**
 * 本文として数える文字列。
 *
 * `manual` のときは `body + '\n' + link`（§9.4 で実際に渡す文字列だから）。
 */
function countedBody(post: SocialPostDraftView): string {
  const body = typeof post.body === 'string' ? post.body : '';
  const link = typeof post.link === 'string' ? post.link : null;
  return post.deliveryMode === 'manual' ? manualText(body, link) : body;
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

/**
 * Bluesky の publisher を組み立てる。
 *
 * `store` は `pds-url` を読むためだけに渡す（設計 §10.1）。
 */
export function createBlueskyPublisher(_options: BlueskyPublisherOptions): PublisherRegistration {
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
          'Bluesky にログインするパスワードではありません。Bluesky の「設定 → プライバシーとセキュリティ → アプリパスワード」で発行した、xxxx-xxxx-xxxx-xxxx の形の文字列を入れます。' +
          'ログイン用のパスワードをここへ入れないでください。App Password はいつでも個別に取り消せます。保存後は再表示されません。',
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

    manual(input: ManualInput): ManualHandoff {
      // **`store` を読まない・`await` しない・例外を投げない。**
      // 2 秒で打ち切られ、1 画面で最大 50 行ぶん呼ばれる（設計 §9.4）。
      const post = input.post;
      const link = typeof post.link === 'string' ? post.link : null;
      return {
        url: `${MANUAL_INTENT_URL}?text=${encodeURIComponent(manualText(post.body, link))}`,
        note: MANUAL_NOTE,
      };
    },
  };
}
