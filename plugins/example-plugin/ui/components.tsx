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

/** 設定画面へ差し込むタブ（`settings.tabs`）。 */
export function ExampleSettingsTab() {
  return (
    <Panel title="サンプルPluginの設定タブ">
      <p style={{ margin: 0 }} data-testid="example-settings-tab">
        Plugin は設定画面へ自分の欄を足せます。
        <a
          href="/plugins/example-plugin/settings"
          style={{ color: 'var(--tf-color-primary)', marginLeft: '0.5rem' }}
        >
          設定を開く
        </a>
      </p>
    </Panel>
  );
}

/** ログイン画面へ差し込む追加のログイン手段（`login.methods`）。 */
export function ExampleLoginMethod() {
  return (
    <p style={{ margin: 0 }} data-testid="example-login-method">
      サンプルPluginのログイン手段（実際には何もしません）
    </p>
  );
}

/**
 * **わざと例外を投げる部品。**
 *
 * Error Boundary が枠だけを落とすことを示すために置いている
 * （`03_リスクと未決事項.md` S-4）。
 * 実装の見本ではない。**自分の Plugin にこれを真似しない。**
 */
export function ExampleBrokenPage() {
  throw new Error('サンプルPlugin：わざと投げた例外');
}
