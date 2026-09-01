/**
 * エラーから接続文字列を取り除く。
 *
 * `DATABASE_URL` にはパスワードが含まれる。pg の例外やスタックトレースへ
 * そのまま混ざると、ログや CI の出力に平文のパスワードが残る。
 */
export function redact(error: unknown, secrets: readonly string[]): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  let message = original.message;
  for (const secret of secrets) {
    if (secret !== '') {
      message = message.split(secret).join('***');
    }
  }
  const redacted = new Error(message);
  redacted.stack = `${redacted.name}: ${message}`;
  return redacted;
}

/** 接続文字列から、伏せるべき文字列（URL全体とパスワード）を取り出す。 */
export function secretsOf(databaseUrl: string): string[] {
  const secrets = [databaseUrl];
  try {
    const url = new URL(databaseUrl);
    if (url.password !== '') {
      secrets.push(url.password);
      secrets.push(`${url.username}:${url.password}`);
    }
  } catch {
    // URL として解釈できない場合は全体を伏せるだけにする。
  }
  return secrets;
}
