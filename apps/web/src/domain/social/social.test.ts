import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_STATUSES,
  canTransition,
  DISPLAY_NAME_MAX_LENGTH,
  isAccountStatus,
  isPostStatus,
  isValidDisplayName,
  isValidPostBody,
  isValidProvider,
  KNOWN_PROVIDERS,
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
