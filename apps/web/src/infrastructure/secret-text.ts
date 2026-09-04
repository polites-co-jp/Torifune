/**
 * 自由文（例外メッセージ）からの接続情報の秘匿（029-scheduled-jobs 設計 §6.1.7）。
 *
 * `job_runs.error` とログの `reason` には例外のメッセージがそのまま入る。
 * Database Provider を差し替えた Plugin の例外は任意の文字列になりうる
 * （接続文字列・トークンを含みうる）。**「入れない」をコメントで宣言するだけでは守られない。**
 *
 * 既存の秘匿処理はそのままでは使えない。
 *
 * * `database/postgres-provider.ts` の `redact(error, connectionString)` はモジュール内の私有関数で、
 *   引数に接続文字列を要求し、戻り値が `Error`（スタックを差し替える）。呼ぶ側は接続文字列を知らない
 * * `infrastructure/logging.ts` の `maskSecrets` は**キー名**で落とす仕組みで、自由文には効かない
 *
 * ここは同じ考え方を小さな純粋関数として切り出したもの。入力は変えず、新しい文字列を返す。
 */

const MASK = '***';

/**
 * `scheme://user:password@host` の credential 部。
 *
 * scheme を限定しない（Provider を差し替えれば PostgreSQL 以外の接続文字列も出うる）。
 * ホストとポートは運用の手がかりとして残す。
 */
const CREDENTIAL_IN_URL = /([a-z][a-z0-9+.-]*:\/\/)[^:/@\s]+:[^@\s]+@/gi;

/** 接続文字列の password 部。URL として読めなければ空文字。 */
function passwordOf(connectionString: string): string {
  try {
    return new URL(connectionString).password;
  } catch {
    return '';
  }
}

/**
 * 自由文から接続情報らしきものを伏せる。
 *
 * * (a) `scheme://user:password@host` 形式の URL の credential 部を `***` にする（Provider を問わず効く）
 * * (b) `DATABASE_URL` が設定されていれば、その全体と、URL として読めるならその password 部分の
 *   完全一致を `***` にする（標準構成の取りこぼしを塞ぐ）
 *
 * **切る前に通すこと**（設計 §6.1.7）。先に切ると、途中で切れた接続文字列が (b) の完全一致に掛からず残る。
 */
export function redactSecrets(text: string): string {
  const configured = process.env['DATABASE_URL'];
  const databaseUrl = configured === undefined ? '' : configured;

  // (b) 全体の完全一致。URL として読めない設定値でも伏せる。
  let redacted = databaseUrl === '' ? text : text.split(databaseUrl).join(MASK);

  // (a) URL 形式の credential。
  redacted = redacted.replace(CREDENTIAL_IN_URL, `$1${MASK}@`);

  // (b) password だけが単独で出てきた場合。
  const password = databaseUrl === '' ? '' : passwordOf(databaseUrl);
  return password === '' ? redacted : redacted.split(password).join(MASK);
}
