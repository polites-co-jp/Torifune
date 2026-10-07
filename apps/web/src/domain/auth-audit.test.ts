import { describe, expect, it } from 'vitest';
import { sanitizeAuditDetail } from './auth-audit';

/**
 * 監査の詳細から機密になりうるキーを落とす `sanitizeAuditDetail`（053-site-scoped-social 実装プラン §8 の 39）。
 *
 * サイトの削除の監査 `{ revokedApiTokens: n }`（設計 §8.6・§8.9・受け入れ条件 #48）は、キー名に `token` を含むので
 * 機械的な除外に掛かる。**キー名の完全一致で、値が数のときだけ**残す例外を固定する。
 * 値が数でなければ（文字列などを誤って入れたら）今までどおり落とす。他のキーの扱いは変えない。
 */

describe('#48（監査の詳細）sanitizeAuditDetail の revokedApiTokens の例外', () => {
  it('#48 revokedApiTokens が数なら残す', () => {
    expect(sanitizeAuditDetail({ revokedApiTokens: 2 })).toEqual({ revokedApiTokens: 2 });
  });

  it('#48 revokedApiTokens が 0 でも残す', () => {
    expect(sanitizeAuditDetail({ revokedApiTokens: 0 })).toEqual({ revokedApiTokens: 0 });
  });

  it.each([
    { label: '文字列', value: 'tf_secret_plaintext' },
    { label: '数の文字列', value: '2' },
    { label: 'null', value: null },
    { label: '配列', value: [1] },
    { label: 'オブジェクト', value: { count: 1 } },
  ])('#48 revokedApiTokens が数でない（$label）なら落とす', ({ value }) => {
    expect(sanitizeAuditDetail({ revokedApiTokens: value })).toEqual({});
  });

  it('#48 例外はキー名の完全一致だけ（大小文字や区切りが違えば今までどおり落とす）', () => {
    expect(
      sanitizeAuditDetail({ RevokedApiTokens: 1, revoked_api_tokens: 1, revokedApiToken: 1 }),
    ).toEqual({});
  });

  it('#48 token を含む他のキーは今までどおり落とし、関係の無いキーは残す', () => {
    expect(
      sanitizeAuditDetail({ apiToken: 'x', token: 'y', tokenHash: 'z', siteId: 's', count: 3 }),
    ).toEqual({ siteId: 's', count: 3 });
  });
});
