import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 定期実行まわりの静的検査（029-scheduled-jobs 設計 §4.1 / §6.1.1 / §12、受け入れ条件 #32、#33、#64、#65）。
 *
 * `ui-shell.test.ts` と同じく、ソース・ファイルを読んで形を固定する。
 *
 * - `instrumentation.ts` が Next.js の要求する場所にあり、Node ランタイムでだけ基盤を起動する
 * - Domain は DB 製品・Infrastructure・Node の API を知らない。Application は `.db` に触れない
 * - `.env.example` とマニュアルが「既定で回る／止めたい人だけ設定する」になっている
 */

/** apps/web/src/application/jobs → apps/web/src */
const SRC_DIR = join(import.meta.dirname, '..', '..');
/** apps/web/src → リポジトリルート */
const REPO_ROOT = join(SRC_DIR, '..', '..', '..');

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

/** ディレクトリ直下の `.ts` / `.tsx`（テストを除く）。 */
function sourceFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => join(dir, name));
}

describe('起動フック（instrumentation.ts）', () => {
  const path = join(SRC_DIR, 'instrumentation.ts');

  /** #32 */
  it('apps/web/src/instrumentation.ts が存在する', () => {
    expect(existsSync(path), 'instrumentation.ts が無い').toBe(true);
  });

  /** #32 */
  it('export async function register を持つ', () => {
    expect(readFileSync(path, 'utf8')).toMatch(/export async function register\s*\(/);
  });

  /** #32。Edge ランタイムのバンドルに pg を入れない。 */
  it('NEXT_RUNTIME を判定し、scheduler を動的 import する', () => {
    const source = withoutComments(readFileSync(path, 'utf8'));

    expect(source).toContain('NEXT_RUNTIME');
    expect(source).toMatch(/import\(\s*['"]@\/application\/jobs\/scheduler['"]\s*\)/);
    // 静的 import にしない（`register()` の外で pg / kysely を読み込まない）。
    expect(source).not.toMatch(/^\s*import .* from ['"]@\/application\/jobs\/scheduler['"]/m);
  });

  /** #32 / §6.1.4。Plugin の起動を `prepare` として注入する。 */
  it('bootScheduler に prepare を渡す', () => {
    const source = withoutComments(readFileSync(path, 'utf8'));

    expect(source).toMatch(/bootScheduler\s*\(\s*\{\s*prepare/);
    expect(source).toMatch(/import\(\s*['"]@\/plugin\/runtime['"]\s*\)/);
  });
});

describe('レイヤの境界', () => {
  const domainFiles = [
    ...sourceFilesIn(join(SRC_DIR, 'domain', 'jobs')),
    join(SRC_DIR, 'domain', 'analytics', 'reception.ts'),
  ];

  /** #33 の前提。検査対象がある。 */
  it('domain/jobs/ と domain/analytics/reception.ts が存在する', () => {
    expect(sourceFilesIn(join(SRC_DIR, 'domain', 'jobs')).length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(SRC_DIR, 'domain', 'analytics', 'reception.ts'))).toBe(true);
  });

  /** #33 */
  it.each(["from 'pg'", "from 'kysely'", "'@/infrastructure", "'node:"])(
    'Domain のジョブ・受信状況が %s を import しない',
    (forbidden) => {
      for (const file of domainFiles) {
        const source = withoutComments(readFileSync(file, 'utf8'));
        expect(source, `${file} が ${forbidden} を含む`).not.toContain(forbidden);
        expect(source, `${file} が ${forbidden} を含む`).not.toContain(
          forbidden.replaceAll("'", '"'),
        );
      }
    },
  );

  /** #33。Application 層は `connection.db` に触れない（SQL は Repository に置く）。 */
  it('application/jobs/*.ts に .db の参照が無い', () => {
    const files = sourceFilesIn(join(SRC_DIR, 'application', 'jobs'));
    expect(files.length).toBeGreaterThanOrEqual(1);

    for (const file of files) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      expect(source, `${file} が .db に触れている`).not.toMatch(/\.db\b/);
    }
  });

  /** §4.1。Application から `plugin/` を import しない（`prepare` として注入する）。 */
  it('application/jobs/*.ts が @/plugin を import しない', () => {
    const files = sourceFilesIn(join(SRC_DIR, 'application', 'jobs'));
    expect(files.length).toBeGreaterThanOrEqual(1);

    for (const file of files) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      expect(source, `${file} が @/plugin を import している`).not.toMatch(/from ['"]@\/plugin/);
    }
  });
});

/**
 * 自由文をログへ載せる箇所の秘匿（029-scheduled-jobs 検証の反映。
 * 受け入れ条件 #85 / #86。security-reviewer M-2 / L-2）。
 *
 * 例外のメッセージは自由文で、Plugin が差し替えた Provider の例外なら接続文字列を含みうる。
 * `logging.ts` の `maskSecrets` はキー名で落とす仕組みなので、`reason` の**中身**には効かない。
 * `job_runs.error` だけ伏せても、同じ例外がログへ素通りするのでは意味が無い。
 *
 * **`reason` を組み立てている場所が `redactSecrets` を通していること**を静的に固定する。
 */
describe('ログへ載せる自由文の秘匿', () => {
  /** 生のメッセージをそのまま `reason` にしている書き方。 */
  const RAW_REASON = /reason:\s*\w+\s+instanceof\s+Error\s*\?\s*\w+\.message\s*:\s*String\(/;

  it.each([
    ['api/route.ts（catch-all）', join(SRC_DIR, 'api', 'route.ts')],
    ['application/jobs/scheduler.ts', join(SRC_DIR, 'application', 'jobs', 'scheduler.ts')],
    ['application/jobs/run-job.ts', join(SRC_DIR, 'application', 'jobs', 'run-job.ts')],
  ])('%s が redactSecrets を通している', (_label, path) => {
    const source = withoutComments(readFileSync(path, 'utf8'));

    expect(source, 'redactSecrets を使っていない').toContain('redactSecrets');
    expect(source, '生の message をそのまま reason にしている').not.toMatch(RAW_REASON);
  });

  /** #85。`reason` を出しているファイルを見落とさないための裏取り。 */
  it('api/route.ts の catch-all が reason を出している（検査が空振りしていない）', () => {
    const source = withoutComments(readFileSync(join(SRC_DIR, 'api', 'route.ts'), 'utf8'));

    expect(source).toContain('unhandled error in route');
    expect(source).toMatch(/reason:/);
  });

  /**
   * #86。接続断を握るなら記録する。
   *
   * `pool.on('error')` / `client.on('error')` の握りつぶしはプロセスを落とさないために要るが、
   * 何も出さないと接続断がどこにも残らない。ログの message は `database connection error`。
   */
  it('postgres-provider.ts が接続断を database connection error として warn に出す', () => {
    const source = withoutComments(
      readFileSync(join(SRC_DIR, 'database', 'postgres-provider.ts'), 'utf8'),
    );

    expect(source, '接続断のログが無い').toContain('database connection error');
    expect(source).toMatch(/log\.warn\(\s*['"]database connection error['"]/);
    expect(source, 'ログの reason に秘匿を通していない').toContain('redactSecrets');
    // 握りつぶし（何もしない購読者）が残っていないこと。
    expect(source, "on('error', () => undefined) のままになっている").not.toMatch(
      /on\(\s*['"]error['"]\s*,\s*\(\s*\)\s*=>\s*undefined\s*\)/,
    );
  });
});

describe('.env.example', () => {
  const envExample = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');

  /** #64 */
  it.each([
    ['TORIFUNE_SCHEDULER', 'on'],
    ['TORIFUNE_ROLLUP_INTERVAL_MINUTES', '15'],
    ['TORIFUNE_WEBHOOK_INTERVAL_MINUTES', '1'],
  ])('%s の行があり、既定値 %s が書かれている', (name, value) => {
    expect(envExample).toMatch(new RegExp(`^${name}=${value}$`, 'm'));
  });

  /** #64。既存の書き方（`# --- 節 ---`）にそろえる。 */
  it('「--- 定期実行 ---」の節がある', () => {
    expect(envExample).toMatch(/^# --- 定期実行 ---$/m);
  });
});

/**
 * 検証結果の反映（設計 §10 #77 / #78）。
 *
 * #77：`findLastRollupAt` は**残す**（裁定 #7、#51 / #52）。設計 §4 のファイル一覧が「削除」と書いていない
 * （spec-verifier B-1。設計と実装が食い違ったまま実装されるのを防ぐ）。
 * #78：advisory lock は `db.connection()` のセッション親和性を暗黙に要求する。
 * 型で強制しない代わりに、コードと §9 の両方へ**要求として書く**（boundary-guardian）。
 */
describe('設計とコードの一致', () => {
  const designPath = join(REPO_ROOT, 'docs', '設計', '029-scheduled-jobs', '設計.md');
  const design = readFileSync(designPath, 'utf8');

  /** 設計 §4 のファイル一覧（```text ブロック）。 */
  function layerBlock(): string {
    const start = design.search(/^## 4\. レイヤ配置$/m);
    expect(start, '§4 が見つからない').toBeGreaterThanOrEqual(0);
    const rest = design.slice(start);
    const end = rest.search(/^### 4\.1/m);
    return end === -1 ? rest : rest.slice(0, end);
  }

  /** #77 */
  it('analytics-repository.ts に findLastRollupAt が残っている', () => {
    const source = readFileSync(join(SRC_DIR, 'infrastructure', 'analytics-repository.ts'), 'utf8');

    expect(source).toContain('findLastRollupAt');
  });

  /** #77 */
  it('設計 §4 の analytics-repository.ts の行が findLastRollupAt を「削除」と書いていない', () => {
    const line = layerBlock()
      .split('\n')
      .find((row) => row.includes('analytics-repository.ts'));

    expect(line, '§4 に analytics-repository.ts の行が無い').toBeDefined();
    expect(line).toContain('findLastRollupAt');
    expect(line).not.toContain('削除');
  });

  /** #77。§4 の一覧に `secret-text.ts` がある（§6.1.7 で新設）。 */
  it('設計 §4 の一覧に secret-text.ts がある', () => {
    expect(layerBlock()).toContain('secret-text.ts');
  });

  /** #78 */
  it('job-lock.ts に「セッション親和性」を保つ要求が書かれている', () => {
    const source = readFileSync(join(SRC_DIR, 'infrastructure', 'job-lock.ts'), 'utf8');

    expect(source).toContain('セッション親和性');
    // 何に対する要求かが読み取れること。
    expect(source).toContain('Database Provider');
  });

  /** #78。設計 §9 の Database Provider の行と一致していること。 */
  it('設計 §9 の Database Provider の行にも同じ要求がある', () => {
    const start = design.search(/^## 9\. Plugin API への影響$/m);
    expect(start, '§9 が見つからない').toBeGreaterThanOrEqual(0);
    const rest = design.slice(start);
    const end = rest.search(/^## 10/m);
    const section = end === -1 ? rest : rest.slice(0, end);

    const line = section.split('\n').find((row) => row.includes('| Database Provider |'));
    expect(line, '§9 に Database Provider の行が無い').toBeDefined();
    expect(line).toContain('セッション親和性');
  });
});

describe('マニュアル', () => {
  const manual = readFileSync(join(REPO_ROOT, 'docs', 'マニュアル', 'アクセス解析設置.md'), 'utf8');

  /** §4 の本文（次の `## ` まで）。 */
  function section4(): string {
    const start = manual.search(/^## 4\./m);
    expect(start, '§4 が見つからない').toBeGreaterThanOrEqual(0);
    const rest = manual.slice(start + 1);
    const end = rest.search(/^## /m);
    return end === -1 ? rest : rest.slice(0, end);
  }

  /** #65 */
  it('§4 に「cron を組まないと出ない」趣旨の文（「集計を回さない限り」）が無い', () => {
    expect(section4()).not.toContain('集計を回さない限り');
  });

  /** #65 */
  it('§4 に TORIFUNE_SCHEDULER=off の説明がある', () => {
    expect(section4()).toContain('TORIFUNE_SCHEDULER=off');
  });

  /** §12。定期実行の状況を見るのに要る権限が書かれている。 */
  it('要る権限に「定期実行」と system.manage が並んでいる', () => {
    expect(manual).toMatch(/定期実行[^\n]*system\.manage/);
  });
});
