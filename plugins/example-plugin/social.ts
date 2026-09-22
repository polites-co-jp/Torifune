import type {
  ManualHandoff,
  ManualInput,
  PluginStore,
  PublishInput,
  PublishResult,
  PublisherRegistration,
  PublisherValidationProblem,
  SocialAccountView,
  SocialPostDraftView,
} from '@torifune/plugin-api';

/**
 * ループバックの publisher（035-social-publishing 設計 §9.8）。
 *
 * **外部サービスへ一切繋がない。** 「投稿した」ことを自分の Key-Value Store へ
 * 書くだけで、どこにも配信されない。ダミーの Authentication Provider と同じ考え方で、
 * 短絡しているのは「外部 SNS が居るかどうか」だけである。
 * 着手印・復号・監査・書き戻し・イベント・手動投稿の画面という
 * Torifune 側の経路は**本番と同じ形で通る。**
 *
 * **Plugin が書くのは「1 回配信する関数」と「投稿画面の URL を返す関数」だけ。**
 * いつ送るか・再試行・記録・画面は Torifune が持つ。自前のタイマーを持たない。
 */

/** `social_accounts.provider` と同じ値。 */
export const EXAMPLE_PROVIDER = 'example';

/** この Plugin のページの名前空間。 */
const PLUGIN_ROUTE = '/plugins/example-plugin';

/** 手動投稿の受け皿（`manual()` が返す URL）。 */
export const MANUAL_POST_ROUTE = `${PLUGIN_ROUTE}/manual-post`;

/** 配信済みの投稿の受け皿（`publish()` が返す `externalUrl`）。 */
export const PUBLISHED_POST_ROUTE = `${PLUGIN_ROUTE}/posts`;

/**
 * 本文の先頭に置くと配信の結果が変わる印。
 *
 * **サンプルのための仕掛けで、実装の見本ではない。**
 * 本物の publisher は外部 SNS の応答から結果を決める。
 */
export const FAIL_MARKER = '[fail]';
export const RETRY_MARKER = '[retry]';
export const THROW_MARKER = '[throw]';
export const ROTATE_MARKER = '[rotate]';

/** 本文のどこかにあると `validate()` が問題を返す印。 */
export const INVALID_MARKER = '[invalid]';

/** 配信した記録の置き場。`posts/<投稿ID>`。 */
function storeKeyOf(postId: string): string {
  return `posts/${postId}`;
}

/**
 * 配信済みの投稿の URL。
 *
 * **Torifune は https の絶対 URL しか `externalUrl` に記録しない**（設計 §5.6）。
 * `APP_URL` が http（開発環境）のときも履歴から辿れるように、scheme だけ https にする。
 */
function publishedUrlOf(postId: string): string {
  const configured = process.env['APP_URL'];
  const fallback = 'https://localhost';
  let origin: string;
  try {
    const url = new URL(configured === undefined || configured === '' ? fallback : configured);
    url.protocol = 'https:';
    origin = url.origin;
  } catch {
    origin = fallback;
  }
  return `${origin}${PUBLISHED_POST_ROUTE}/${postId}`;
}

export interface ExamplePublisherOptions {
  /** 配信した記録を書く先。**資格情報はここへ写さない**（呼び出しの間だけ有効）。 */
  readonly store: PluginStore;
}

export function createExamplePublisher(options: ExamplePublisherOptions): PublisherRegistration {
  const { store } = options;

  return {
    provider: EXAMPLE_PROVIDER,
    label: 'サンプルSNS',

    /**
     * 資格情報の形。
     *
     * **入力欄と形式検証は Torifune が持つ。** ここは「何が要るか」の宣言だけ。
     * `kind` の違いは打ち込むときの見え方で、保存はどちらも暗号化される。
     */
    credentialFields: [
      {
        key: 'handle',
        label: 'サンプルSNSのハンドル',
        description: 'サンプルSNS 側の利用者名。',
        kind: 'text',
      },
      {
        key: 'appPassword',
        label: 'アプリパスワード',
        description: '保存後は再表示されません。',
        kind: 'secret',
      },
    ],

    // SNS ごとの上限。粗く早く弾くためのもので、厳密な判定は validate() で行う。
    limits: { bodyMaxLength: 100, mediaMax: 2 },

    validate(input: {
      readonly post: SocialPostDraftView;
      readonly account: SocialAccountView;
    }): readonly PublisherValidationProblem[] {
      // 本物はここで SNS ごとの数え方（URL は 23 文字など）を確かめる。
      if (input.post.body.includes(INVALID_MARKER)) {
        return [
          { field: 'body', message: `本文に ${INVALID_MARKER} は使えません（サンプルSNS）。` },
        ];
      }
      return [];
    },

    async publish(input: PublishInput): Promise<PublishResult> {
      const { post, attempt, logger } = input;

      // **資格情報の値をログに渡さない。** キー名で伏せる仕掛けはあるが、
      // 値まで守るのは Plugin の責任（設計 §6.5.5）。
      logger.info('サンプルSNSへ配信する', { postId: post.id, attempt });

      if (post.body.startsWith(THROW_MARKER)) {
        // 例外は常に「不明」として failed になる（再送しない）。
        throw new Error('サンプルSNS：わざと投げた例外');
      }

      if (post.body.startsWith(FAIL_MARKER)) {
        return {
          ok: false,
          reason: 'サンプルSNS：わざと失敗させました（再試行しません）。',
          retryable: false,
        };
      }

      if (post.body.startsWith(RETRY_MARKER)) {
        // 「送る前に失敗した」ので再試行してよい。届いたか分からない失敗は false にする。
        return {
          ok: false,
          reason: 'サンプルSNS：わざと失敗させました（再試行します）。',
          retryable: true,
        };
      }

      // **ここが「配信」。** 外部へは出ず、自分の Key-Value Store に残るだけ。
      await store.set(storeKeyOf(post.id), { postId: post.id, at: new Date().toISOString() });

      const published = {
        ok: true,
        externalId: post.id,
        externalUrl: publishedUrlOf(post.id),
      } as const;

      if (post.body.startsWith(ROTATE_MARKER)) {
        // 本物はトークンの延長で返す。**保存し直すのは Torifune の仕事。**
        return { ...published, rotatedCredential: { ...input.credential, appPassword: 'rotated' } };
      }

      return published;
    },

    manual(input: ManualInput): ManualHandoff {
      // **資格情報は渡らない。** 手動投稿の URL は公開の投稿画面（Web Intent）である。
      return {
        url: `${MANUAL_POST_ROUTE}?text=${encodeURIComponent(input.post.body)}`,
        note: 'サンプルです。実際にはどこにも投稿されません。',
      };
    },
  };
}
