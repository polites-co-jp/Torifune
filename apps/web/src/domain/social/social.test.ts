import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_STATUSES,
  canTransition,
  DELIVERY_MODES,
  DISPLAY_NAME_MAX_LENGTH,
  isAccountStatus,
  isDeliveryMode,
  isManualPending,
  isPostStatus,
  isValidDisplayName,
  isValidMediaUrl,
  isValidPostBody,
  isValidProvider,
  KNOWN_PROVIDERS,
  MEDIA_URL_MAX_LENGTH,
  POST_BODY_MAX_LENGTH,
  POST_STATUSES,
  providerLabel,
} from './social';

describe('isValidProvider', () => {
  it('既知の provider を受け入れる', () => {
    for (const provider of KNOWN_PROVIDERS) {
      expect(isValidProvider(provider)).toBe(true);
    }
  });

  it('未知の provider も受け入れる', () => {
    // Plugin が新しいSNSを足せる必要がある。
    expect(isValidProvider('mastodon')).toBe(true);
    expect(isValidProvider('bluesky')).toBe(true);
  });

  it('アンダースコアを受け入れる', () => {
    expect(isValidProvider('my_service')).toBe(true);
  });

  it('大文字を拒否する', () => {
    expect(isValidProvider('Twitter')).toBe(false);
  });

  it('記号を拒否する', () => {
    expect(isValidProvider('x-com')).toBe(false);
    expect(isValidProvider('x.com')).toBe(false);
    expect(isValidProvider('../etc')).toBe(false);
  });

  it('空文字を拒否する', () => {
    expect(isValidProvider('')).toBe(false);
  });

  it('先頭が数字の名前を拒否する', () => {
    expect(isValidProvider('1sns')).toBe(false);
  });

  it('長すぎる名前を拒否する', () => {
    expect(isValidProvider('a'.repeat(33))).toBe(false);
  });
});

describe('providerLabel', () => {
  it('既知の provider は表示名を返す', () => {
    expect(providerLabel('x')).toBe('X');
  });

  it('未知の provider はそのまま返す', () => {
    expect(providerLabel('mastodon')).toBe('mastodon');
  });
});

describe('isValidDisplayName', () => {
  it('通常の名前を受け入れる', () => {
    expect(isValidDisplayName('とりふね公式')).toBe(true);
  });

  it('空白だけを拒否する', () => {
    expect(isValidDisplayName('   ')).toBe(false);
  });

  it('上限を超えたら拒否する', () => {
    expect(isValidDisplayName('a'.repeat(DISPLAY_NAME_MAX_LENGTH + 1))).toBe(false);
  });
});

describe('isValidPostBody', () => {
  it('通常の本文を受け入れる', () => {
    expect(isValidPostBody('こんにちは')).toBe(true);
  });

  it('空白だけを拒否する', () => {
    expect(isValidPostBody('  \n ')).toBe(false);
  });

  it('上限ちょうどを受け入れる', () => {
    expect(isValidPostBody('a'.repeat(POST_BODY_MAX_LENGTH))).toBe(true);
  });

  it('上限を超えたら拒否する', () => {
    expect(isValidPostBody('a'.repeat(POST_BODY_MAX_LENGTH + 1))).toBe(false);
  });
});

describe('canTransition', () => {
  it('draft から scheduled へ進める', () => {
    expect(canTransition('draft', 'scheduled')).toBe(true);
  });

  it('scheduled から published へ進める', () => {
    expect(canTransition('scheduled', 'published')).toBe(true);
  });

  it('draft から published へ直接進める', () => {
    expect(canTransition('draft', 'published')).toBe(true);
  });

  it('scheduled から draft へ戻せる', () => {
    // まだ配信していないので、予約を取り消して下書きへ戻すのは自然。
    expect(canTransition('scheduled', 'draft')).toBe(true);
  });

  it('published から draft へ戻せない', () => {
    // 起きた事実は書き換えない。「配信した」を戻せると記録が信用できなくなる。
    expect(canTransition('published', 'draft')).toBe(false);
  });

  it('published から scheduled へ戻せない', () => {
    expect(canTransition('published', 'scheduled')).toBe(false);
  });

  it('published から failed へ変えられない', () => {
    expect(canTransition('published', 'failed')).toBe(false);
  });

  it('failed から draft へ戻せない', () => {
    expect(canTransition('failed', 'draft')).toBe(false);
  });

  it('同じ状態への遷移は許す', () => {
    // 本文だけを更新するとき、状態を触らない更新が弾かれないように。
    for (const status of POST_STATUSES) {
      expect(canTransition(status, status)).toBe(true);
    }
  });
});

describe('状態の判定', () => {
  it('定義済みの投稿状態を受け入れる', () => {
    for (const status of POST_STATUSES) {
      expect(isPostStatus(status)).toBe(true);
    }
  });

  it('定義外の投稿状態を拒否する', () => {
    expect(isPostStatus('deleted')).toBe(false);
  });

  it('定義済みのアカウント状態を受け入れる', () => {
    for (const status of ACCOUNT_STATUSES) {
      expect(isAccountStatus(status)).toBe(true);
    }
  });

  it('定義外のアカウント状態を拒否する', () => {
    expect(isAccountStatus('pending')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 035-social-publishing 設計 §5.6.1（受け入れ条件 #5、#9、#12）
// ---------------------------------------------------------------------------

describe('isDeliveryMode', () => {
  /** #5 */
  it('定義済みの配信方法を受け入れる', () => {
    for (const mode of DELIVERY_MODES) {
      expect(isDeliveryMode(mode)).toBe(true);
    }
  });

  /** #5。DB の CHECK 制約と同じ値しか通さない。 */
  it('大文字を拒否する', () => {
    expect(isDeliveryMode('Auto')).toBe(false);
  });

  /** #5 */
  it('空文字を拒否する', () => {
    expect(isDeliveryMode('')).toBe(false);
  });
});

describe('isValidMediaUrl', () => {
  /** #5 */
  it('https の URL を受け入れる', () => {
    expect(isValidMediaUrl('https://a/b.png')).toBe(true);
  });

  /**
   * #5。Plugin が取りに行く URL なので、localhost の http も許さない
   * （`isValidWebhookUrl` と違い、開発用の抜け道を作らない。設計 §5.6.1）。
   */
  it('http の URL を受け入れない', () => {
    expect(isValidMediaUrl('http://a/b.png')).toBe(false);
  });

  /** #5。保存すると一覧やログに資格情報が載る。 */
  it('URL に資格情報を書かせない', () => {
    expect(isValidMediaUrl('https://u:p@a/b.png')).toBe(false);
  });

  /** #5 */
  it('上限ちょうどの長さを受け入れる', () => {
    const url = `https://example.com/${'a'.repeat(MEDIA_URL_MAX_LENGTH - 20)}`;

    expect(url).toHaveLength(MEDIA_URL_MAX_LENGTH);
    expect(isValidMediaUrl(url)).toBe(true);
  });

  /** #5 */
  it('上限を超えた長さを拒否する', () => {
    const url = `https://example.com/${'a'.repeat(MEDIA_URL_MAX_LENGTH - 19)}`;

    expect(url).toHaveLength(MEDIA_URL_MAX_LENGTH + 1);
    expect(isValidMediaUrl(url)).toBe(false);
  });

  /** #5 */
  it.each(['', 'not a url', 'javascript:alert(1)', 'file:///etc/passwd'])(
    '不正な URL を受け入れない: %s',
    (value) => {
      expect(isValidMediaUrl(value)).toBe(false);
    },
  );
});

describe('isManualPending', () => {
  const now = new Date('2026-09-22T10:00:00.000Z');

  /** #9。状態は増やさず、manual かつ scheduled かつ期限到来で導出する（裁定 #3）。 */
  it('予約時刻の来た手動投稿は投稿待ちになる', () => {
    const post = {
      deliveryMode: 'manual',
      status: 'scheduled',
      scheduledAt: new Date(now.getTime() - 1_000),
    } as const;

    expect(isManualPending(post, now)).toBe(true);
  });

  /** #9 */
  it('予約時刻がまだ先の手動投稿は投稿待ちではない', () => {
    const post = {
      deliveryMode: 'manual',
      status: 'scheduled',
      scheduledAt: new Date(now.getTime() + 1_000),
    } as const;

    expect(isManualPending(post, now)).toBe(false);
  });

  /** #9。自動配信はジョブが送るので、人の出番は無い。 */
  it('自動配信の投稿は投稿待ちではない', () => {
    const post = {
      deliveryMode: 'auto',
      status: 'scheduled',
      scheduledAt: new Date(now.getTime() - 1_000),
    } as const;

    expect(isManualPending(post, now)).toBe(false);
  });

  /** #9。「取りやめ」で下書きへ戻した投稿は一覧から消える（§6.2）。 */
  it('下書きの投稿は投稿待ちではない', () => {
    const post = {
      deliveryMode: 'manual',
      status: 'draft',
      scheduledAt: new Date(now.getTime() - 1_000),
    } as const;

    expect(isManualPending(post, now)).toBe(false);
  });

  /** #9。予約日時の無い行は期限が来ない（§5.3）。 */
  it('予約日時の無い投稿は投稿待ちではない', () => {
    const post = { deliveryMode: 'manual', status: 'scheduled', scheduledAt: null } as const;

    expect(isManualPending(post, now)).toBe(false);
  });
});

describe('providerLabel（publisher の表示名）', () => {
  /** #12。Plugin を無効にしても表示名が生の値に落ちないように Core が知っておく。 */
  it('bluesky の表示名を Core が知っている', () => {
    expect(providerLabel('bluesky')).toBe('Bluesky');
  });

  /** #12 */
  it('bluesky が既知の provider に入っている', () => {
    expect(KNOWN_PROVIDERS).toContain('bluesky');
  });

  /** #12。登録された publisher の label を優先する（要件 §5.1）。 */
  it('publisher の表示名が Core の表示名より優先される', () => {
    expect(providerLabel('x', { x: 'X（Plugin）' })).toBe('X（Plugin）');
  });

  /** #12 */
  it('どちらにも無い provider はそのまま返す', () => {
    expect(providerLabel('mastodon', { x: 'X（Plugin）' })).toBe('mastodon');
  });
});
