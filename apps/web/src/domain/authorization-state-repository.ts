import type { Connection } from '../database/provider';
import type { AuthorizationState } from './authorization-state';

/**
 * リダイレクト型認証の State の保管（025-redirect-authentication 設計 §6）。
 *
 * `PasswordResetRepository` と同じ流儀にそろえる。
 * **State そのものは保存しない。ハッシュだけを保存する。**
 */

export interface NewAuthorizationState {
  readonly id: string;
  readonly stateHash: string;
  readonly nonce: string;
  readonly providerId: string;
  readonly redirectUri: string;
  readonly returnTo: string;
  readonly expiresAt: Date;
}

export interface AuthorizationStateRepository {
  insert(connection: Connection, state: NewAuthorizationState): Promise<void>;
  findByStateHash(connection: Connection, stateHash: string): Promise<AuthorizationState | null>;
  /**
   * 使用済みにする。
   *
   * **まだ未使用だったときだけ true を返す。**
   * 同じ State を持つ要求が同時に2本来ても、通るのは1本だけになる。
   * 真偽を返さない `markUsed` にすると、二重使用を防げない。
   */
  markUsed(connection: Connection, id: string, at: Date): Promise<boolean>;
  /** 期限切れを掃除する。放っておくと使えない行が溜まり続ける。 */
  deleteExpired(connection: Connection, before: Date): Promise<void>;
}
