import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOCIAL_PUBLISH_JOB } from '@/application/jobs/definitions';
import { JOB_NAMES } from '@/domain/jobs/job';
import { JOB_LABEL } from '@/ui/analytics/labels';

/**
 * SNS 配信まわりの静的検査（035-social-publishing、受け入れ条件 #59、#67）。
 *
 * `application/jobs/static-checks.test.ts` と同じ流儀で、ソース・ファイルと
 * 定数の形を固定する。
 *
 * **このファイルは G8（T28）で #18（境界）・#81〜#84 が足される場所でもある**
 * （実装プラン §8 の 6）。いまは G4 の範囲（#59 / #67）だけを置く。
 */

/** apps/web/src/application/social → apps/web/src */
const SRC_DIR = join(import.meta.dirname, '..', '..');
/** apps/web/src → リポジトリルート */
const REPO_ROOT = join(SRC_DIR, '..', '..', '..');

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

/**
 * #59。ジョブ定義の形（設計 §6.5.1）。
 *
 * `lockName` を書かなければ `job.lockName ?? job.name` が自分の名前に落ち、
 * ロールアップ・Webhook と並行して走れる。書くと他のジョブと直列化される。
 */
describe('#59 ジョブ定義の形', () => {
  it('#59 SOCIAL_PUBLISH_JOB.lockName が未定義（social.publish 自身の鍵を取る）', () => {
    expect((SOCIAL_PUBLISH_JOB as { lockName?: string }).lockName).toBeUndefined();
  });

  it('#59 SOCIAL_PUBLISH_JOB の名前が social.publish', () => {
    expect(SOCIAL_PUBLISH_JOB.name).toBe('social.publish');
  });

  it('#59 JOB_NAMES の最後が social.publish', () => {
    // **末尾に足す。** この順がそのまま設定画面「定期実行」の行順になる。
    expect(JOB_NAMES[JOB_NAMES.length - 1]).toBe('social.publish');
  });

  it('#59 既存のジョブ名の順序が変わっていない', () => {
    expect(JOB_NAMES).toEqual([
      'analytics.rollup',
      'webhook.deliver',
      'analytics.timezoneRebuild',
      'social.publish',
    ]);
  });

  it('#59 JOB_LABEL に social.publish の表示名がある', () => {
    expect(JOB_LABEL['social.publish']).toBe('SNS 投稿の配信');
  });
});

/** #67。環境変数の案内と、起動フックを変えていないこと（設計 §6.5.1）。 */
describe('#67 .env.example と instrumentation.ts', () => {
  const envExample = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');

  it('#67 TORIFUNE_SOCIAL_PUBLISH_INTERVAL_MINUTES の行があり、既定値が 1', () => {
    expect(envExample).toMatch(/^TORIFUNE_SOCIAL_PUBLISH_INTERVAL_MINUTES=1$/m);
  });

  it('#67 TORIFUNE_SCHEDULER の案内に POST /api/v1/social/publish がある', () => {
    // `off` の運用を SNS でも成り立たせる（設計 §6.5.9）。
    expect(envExample).toContain('/api/v1/social/publish');
  });

  it('#67 instrumentation.ts は prepare の注入のままで、SNS 固有の記述が無い', () => {
    // `prepare` は既存（`ensurePluginsStartedAnonymously`）。ジョブが増えても
    // 起動フックは変わらない（設計 §6.5.1 の `prepare` の行）。
    const source = withoutComments(readFileSync(join(SRC_DIR, 'instrumentation.ts'), 'utf8'));

    expect(source).toMatch(/bootScheduler\s*\(\s*\{\s*prepare:\s*ensurePluginsStartedAnonymously/);
    expect(source).not.toContain('social');
  });
});
