/**
 * Next.js の起動フック（029-scheduled-jobs 設計 §6.1.1）。
 *
 * `register()` は `next start` / `next dev` のサーバー起動時に 1 回呼ばれる
 * （`next build` では呼ばれない）。ここで本体の定期実行を起こす。
 *
 * **レイヤの外の入口**。`app/` と同格で、中身は Application の起動関数を呼ぶだけにする。
 *
 * * **動的 import にする。** 静的に書くと Edge ランタイムのバンドルへ `pg` が入る
 * * **DB に触らない。** DB が起動待ちでも本体の起動を止めない（最初の実行は初回遅延の後）
 * * Plugin の起動（`ensurePluginsStartedAnonymously`）は `prepare` として注入する。
 *   Application から `plugin/` を import しないため（§6.1.4）
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') {
    return;
  }

  const [{ bootScheduler }, { ensurePluginsStartedAnonymously }] = await Promise.all([
    import('@/application/jobs/scheduler'),
    import('@/plugin/runtime'),
  ]);

  bootScheduler({ prepare: ensurePluginsStartedAnonymously });
}
