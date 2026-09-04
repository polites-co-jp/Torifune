import { afterEach, describe, expect, it, vi } from 'vitest';
import { redactSecrets } from './secret-text';

/**
 * 自由文からの接続情報の秘匿（029-scheduled-jobs 設計 §6.1.7、受け入れ条件 #74）。
 *
 * `job_runs.error` とログの `reason` には例外のメッセージがそのまま入る。
 * Database Provider を差し替えた Plugin の例外は任意の文字列になりうる（接続文字列・トークンを含みうる）。
 *
 * - (a) `scheme://user:password@host` 形式の URL を見つけたら credential 部を `***` にする（Provider を問わず効く）
 * - (b) `process.env['DATABASE_URL']` が設定されていれば、その全体と、URL として解釈できるなら
 *   その password 部分の完全一致を `***` にする（標準構成の取りこぼしを塞ぐ）
 *
 * `infrastructure/logging.ts` の `maskSecrets` はキー名で落とす仕組みで、自由文には効かない。
 * こちらは自由文が対象なので、両方が要る。
 */

const MASK = '***';
const SAMPLE_URL = 'postgresql://torifune:s3cret@db:5432/torifune';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('URL 形式の credential（a）', () => {
  /** #74 */
  it('postgresql://user:password@host の credential を伏せる', () => {
    const redacted = redactSecrets(`接続に失敗した: ${SAMPLE_URL}`);

    expect(redacted).not.toContain('s3cret');
    expect(redacted).toContain(MASK);
    // どのホスト・どのデータベースだったかは運用の手がかりとして残す。
    expect(redacted).toContain('db:5432');
  });

  /** #74。Provider を問わず効く（scheme は postgresql に限らない）。 */
  it.each([
    'mysql://root:hunter2@mysql.internal:3306/app',
    'https://api-user:tok3n@api.example.com/v1',
    'amqp://guest:guest@rabbit:5672',
  ])('%s の credential を伏せる', (url) => {
    const redacted = redactSecrets(`failed to connect to ${url}`);

    const password = /\/\/[^:/@\s]+:([^@\s]+)@/.exec(url)?.[1] ?? '';
    expect(password.length).toBeGreaterThan(0);
    expect(redacted).not.toContain(password);
    expect(redacted).toContain(MASK);
  });

  /** #74。1 つの文に 2 つ出てきても両方伏せる。 */
  it('同じ文の中に 2 つあれば両方伏せる', () => {
    const redacted = redactSecrets(
      `primary=postgresql://a:pass1@h1:5432/db replica=postgresql://b:pass2@h2:5432/db`,
    );

    expect(redacted).not.toContain('pass1');
    expect(redacted).not.toContain('pass2');
  });

  /** #74。パスワードを持たない URL は壊さない。 */
  it('credential を持たない URL は変えない', () => {
    const text = 'GET https://example.com/health が 503 を返した';

    expect(redactSecrets(text)).toBe(text);
  });

  /** #74 */
  it('無関係な文字列は変えない', () => {
    for (const text of [
      '集計に失敗した',
      'relation "job_runs" does not exist',
      '',
      'a:b@c', // scheme が無い（URL ではない）
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  /** #74。入力を書き換えず、新しい文字列を返す。 */
  it('入力の文字列を変えない', () => {
    const original = `接続に失敗した: ${SAMPLE_URL}`;
    const copy = original;

    redactSecrets(original);

    expect(original).toBe(copy);
  });
});

describe('DATABASE_URL の完全一致（b）', () => {
  /** #74 */
  it('DATABASE_URL の値そのものを伏せる', () => {
    vi.stubEnv('DATABASE_URL', SAMPLE_URL);

    const redacted = redactSecrets(`ECONNREFUSED ${SAMPLE_URL}`);

    expect(redacted).not.toContain(SAMPLE_URL);
    expect(redacted).toContain(MASK);
  });

  /** #74。password 部分だけが単独で出てきても伏せる。 */
  it('DATABASE_URL の password 部分の完全一致を伏せる', () => {
    vi.stubEnv('DATABASE_URL', SAMPLE_URL);

    const redacted = redactSecrets('password authentication failed for password s3cret');

    expect(redacted).not.toContain('s3cret');
    expect(redacted).toContain(MASK);
  });

  /** #74。DATABASE_URL が未設定でも落ちず、(a) は効く。 */
  it('DATABASE_URL が未設定でも例外にならず、URL 形式は伏せる', () => {
    vi.stubEnv('DATABASE_URL', '');

    const redacted = redactSecrets(`接続に失敗した: ${SAMPLE_URL}`);

    expect(redacted).not.toContain('s3cret');
  });

  /** #74。URL として読めない DATABASE_URL でも落ちない。 */
  it('DATABASE_URL が URL として読めなくても例外にならない', () => {
    vi.stubEnv('DATABASE_URL', 'not-a-url');

    expect(() => redactSecrets('not-a-url で接続に失敗した')).not.toThrow();
    expect(redactSecrets('not-a-url で接続に失敗した')).not.toContain('not-a-url');
  });
});
