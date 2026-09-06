/**
 * Next.js の起動フック（029-scheduled-jobs 設計 §6.1.1）。
 *
 * `register()` は `next start` / `next dev` のサーバー起動時に 1 回呼ばれる
 * （`next build` では呼ばれない）。ここで本体の定期実行を起こす。
 *
 * **レイヤの外の入口**。`app/` と同格で、中身は Application の起動関数を呼ぶだけにする。
 *
 * * **動的 import にする。** 静的に書くと Edge ランタイムのバンドルへ `pg` が入る
 * * **DB を待たない・DB の失敗で起動を止めない。**
 *   `029` §6.1.1 は「DB に触らない」と書いていたが、032-timezone-setting で
 *   基準タイムゾーンの暖機（`resolveAnalyticsTimeZone()`）が加わり、
 *   **best-effort で実際に接続を張る**ようになった（`032` §6.1.2）。
 *   守っている不変条件は変わらない——**起動時要件を増やさない**。
 *   暖機は `void … .catch()` で待たず・失敗も握るので `register()` は即座に返り、
 *   DB が落ちていても起動する（警告が 1 組出て、値は env → `UTC` へ落ち、
 *   次の `resolveAnalyticsTimeZone()` が TTL 超過で読み直す）。
 *   定期実行の最初の実行は従来どおり初回遅延の後
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

  // 基準タイムゾーンのキャッシュを best-effort で暖める（032-timezone-setting 設計 §6.1.2）。
  // **待たない・失敗させない。** DB が起動待ちでも本体の起動を止めない（§6.1.1 の方針）。
  // ここも動的 import にする（静的だと Edge ランタイムのバンドルへ `pg` が入る）。
  void import('@/application/analytics/timezone')
    .then(({ resolveAnalyticsTimeZone }) => resolveAnalyticsTimeZone())
    .catch(() => undefined);
}
