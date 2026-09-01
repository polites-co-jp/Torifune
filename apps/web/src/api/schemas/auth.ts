import { z } from 'zod';
import { dataEnvelope } from './envelope';

/**
 * 認証まわりの応答スキーマ（05_API設計.md §12-13、04_認証設計.md）。
 *
 * **秘密は載せない。** セッションは HttpOnly Cookie で運び、
 * 本文へトークンやハッシュを出さない。
 */

export const csrfTokenEnvelopeSchema = dataEnvelope(z.object({ csrfToken: z.string() }));

/**
 * 現在ログインしているユーザー。
 *
 * `permissions` は **UI の表示制御のため**に返す。
 * 認可はサーバー側で行っており、この配列を書き換えても判定は変わらない
 * （06_画面設計.md §29）。
 */
export const currentUserEnvelopeSchema = dataEnvelope(
  z.object({
    id: z.string(),
    loginId: z.string(),
    displayName: z.string(),
    email: z.string(),
    permissions: z.array(z.string()),
  }),
);
