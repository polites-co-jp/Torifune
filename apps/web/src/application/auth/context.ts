import type { Connection } from '../../database/provider';
import type { AuthenticationContext } from '../../authentication/provider';

/** リクエストから取れる、認証処理に必要な情報。 */
export interface RequestInfo {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export function authContext(
  connection: Connection,
  request: RequestInfo,
  now: Date = new Date(),
): AuthenticationContext {
  return {
    connection,
    ipAddress: request.ipAddress,
    userAgent: request.userAgent,
    now,
  };
}
