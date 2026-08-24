import { describe, expect, it } from 'vitest';
import {
  CORE_PERMISSIONS,
  InvalidPermissionNameError,
  isReservedPermissionNamespace,
  isValidPermissionName,
  toPermissionName,
} from './permission';

describe('isValidPermissionName', () => {
  it('resource.action 形式を受け入れる', () => {
    expect(isValidPermissionName('site.read')).toBe(true);
  });

  it('Plugin の名前空間（3階層）も受け入れる', () => {
    expect(isValidPermissionName('seo.report.read')).toBe(true);
  });

  it('アンダースコアを受け入れる', () => {
    expect(isValidPermissionName('social_post.write')).toBe(true);
  });

  it('大文字を拒否する', () => {
    expect(isValidPermissionName('Site.Read')).toBe(false);
  });

  it('ドットが無い名前を拒否する', () => {
    expect(isValidPermissionName('siteread')).toBe(false);
  });

  it('先頭が数字の名前を拒否する', () => {
    expect(isValidPermissionName('1site.read')).toBe(false);
  });

  it('空文字を拒否する', () => {
    expect(isValidPermissionName('')).toBe(false);
  });

  it('ハイフンを許す', () => {
    // Plugin ID がハイフンを含むため、許さないと Plugin が
    // 自分の ID を Permission の名前空間にできない。
    expect(isValidPermissionName('seo-plugin.report.read')).toBe(true);
  });

  it('先頭がハイフンの名前を拒否する', () => {
    expect(isValidPermissionName('-seo.read')).toBe(false);
    expect(isValidPermissionName('seo.-read')).toBe(false);
  });

  it('末尾がドットの名前を拒否する', () => {
    expect(isValidPermissionName('site.')).toBe(false);
  });

  it('連続するドットを拒否する', () => {
    expect(isValidPermissionName('site..read')).toBe(false);
  });

  it('長すぎる名前を拒否する', () => {
    expect(isValidPermissionName(`${'a'.repeat(100)}.read`)).toBe(false);
  });
});

describe('toPermissionName', () => {
  it('正しい名前をそのまま返す', () => {
    expect(toPermissionName('site.read')).toBe('site.read');
  });

  it('不正な名前で例外を投げる', () => {
    expect(() => toPermissionName('BAD')).toThrowError(InvalidPermissionNameError);
  });

  it('例外に元の値を持たせる', () => {
    try {
      toPermissionName('BAD');
      expect.unreachable();
    } catch (error) {
      expect((error as InvalidPermissionNameError).value).toBe('BAD');
    }
  });
});

describe('isReservedPermissionNamespace', () => {
  it('system.* を予約とみなす', () => {
    expect(isReservedPermissionNamespace('system.manage')).toBe(true);
  });

  it('それ以外は予約ではない', () => {
    expect(isReservedPermissionNamespace('site.read')).toBe(false);
  });

  it('systemic.x のような紛らわしい名前を予約とみなさない', () => {
    expect(isReservedPermissionNamespace('systemic.read')).toBe(false);
  });
});

describe('CORE_PERMISSIONS', () => {
  it('9 種ある', () => {
    // コンテンツは Core の責務ではない（改訂履歴.md 2026-08-24）。
    expect(CORE_PERMISSIONS).toHaveLength(9);
  });

  it('すべて形式が正しい', () => {
    for (const name of CORE_PERMISSIONS) {
      expect(isValidPermissionName(name)).toBe(true);
    }
  });

  it('重複が無い', () => {
    expect(new Set(CORE_PERMISSIONS).size).toBe(CORE_PERMISSIONS.length);
  });
});
