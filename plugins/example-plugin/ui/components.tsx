/**
 * サンプル Plugin の画面部品。
 *
 * **`@torifune/plugin-api` 以外の Torifune のモジュールを import しない。**
 * 本体の内部へ手を伸ばすと、本体の再編で Plugin が壊れる。
 *
 * 見た目はデザイントークン（`--tf-*`）に寄せる。
 * 独自の色や余白を持ち込むと、画面全体の統一感が崩れる
 * （`docs/仕様書/06_画面設計.md` §32）。
 */

/** Torifune の Card に寄せた枠。 */
export function Panel({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section
      style={{
        background: 'var(--tf-color-bg)',
        border: '1px solid var(--tf-color-border)',
        borderRadius: 'var(--tf-radius-md)',
        padding: 'var(--tf-space-4)',
      }}
    >
      <h3 style={{ margin: '0 0 var(--tf-space-2)', fontSize: '0.95rem' }}>{title}</h3>
      {children}
    </section>
  );
}

/** ダッシュボードへ出す Widget。 */
export function ExampleWidget() {
  return (
    <Panel title="サンプルPlugin">
      <p style={{ margin: 0, color: 'var(--tf-color-text-muted)' }} data-testid="example-widget">
        この枠は Plugin が足しています。
      </p>
    </Panel>
  );
}

/** Webサイト一覧へ出す Action。 */
export function ExampleSiteAction() {
  return (
    <a
      href="/plugins/example-plugin"
      data-testid="example-site-action"
      style={{ color: 'var(--tf-color-primary)' }}
    >
      サンプルPluginで見る
    </a>
  );
}

/** Webサイト編集画面のサイドバーへ出す欄。 */
export function ExampleSiteSidebar(props: Record<string, unknown>) {
  const siteId = typeof props['siteId'] === 'string' ? props['siteId'] : '(不明)';

  return (
    <Panel title="サンプルPluginの欄">
      <p style={{ margin: 0 }} data-testid="example-site-sidebar">
        このサイトのID: <code>{siteId}</code>
      </p>
    </Panel>
  );
}
