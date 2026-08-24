import type { PluginDataApi } from '@torifune/plugin-api';
import { Panel } from './components';

/**
 * サンプル Plugin のページ。
 *
 * **描画時に渡される `data` を使う。**
 * `activate()` で受け取った Data API は、そのとき起動したユーザーの権限に
 * 縛られている。画面で使うと、見ている人と違う権限で読むことになる。
 */

interface PluginPageProps {
  readonly pluginId?: unknown;
  readonly route?: unknown;
  readonly data?: unknown;
}

function dataApiOf(props: PluginPageProps): PluginDataApi | null {
  return typeof props.data === 'object' && props.data !== null
    ? (props.data as PluginDataApi)
    : null;
}

/** `/plugins/example-plugin` — Data API で Webサイトを読む。 */
export async function ExamplePage(props: PluginPageProps) {
  const data = dataApiOf(props);

  if (data === null) {
    return <Panel title="サンプルPlugin">Data API を受け取れませんでした。</Panel>;
  }

  // Manifest で site.read を宣言しているため呼べる。
  // 宣言していなければ PluginPermissionError になる。
  const sites = await data.sites.list({ page: 1, perPage: 5 });

  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-4)' }}>
      <h1 style={{ fontSize: '1.25rem', margin: 0 }}>サンプルPlugin</h1>

      <Panel title="Data API から読んだWebサイト">
        <p style={{ marginTop: 0, color: 'var(--tf-color-text-muted)' }}>
          全 <span data-testid="example-site-total">{sites.total}</span> 件
        </p>
        {sites.items.length === 0 ? (
          <p style={{ margin: 0 }} data-testid="example-site-empty">
            Webサイトがまだありません。
          </p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: '1.25rem' }} data-testid="example-site-list">
            {sites.items.map((site) => (
              <li key={site.id}>{site.name}</li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="この Plugin ができること">
        <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
          <li>左ナビへの項目追加とこのページ</li>
          <li>ダッシュボードへの Widget 追加</li>
          <li>Webサイト一覧への Action 追加</li>
          <li>Webサイト編集画面のサイドバーへの追加</li>
          <li>
            <code>site.created</code> の購読
          </li>
          <li>設定（一般設定と Secret を1つずつ）</li>
          <li>ダミーの Database Provider</li>
        </ul>
      </Panel>

      <p>
        <a href="/plugins/example-plugin/settings" style={{ color: 'var(--tf-color-primary)' }}>
          設定へ
        </a>
      </p>
    </div>
  );
}
