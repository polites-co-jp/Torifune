import type { PluginDataApi } from '@torifune/plugin-api';
import { Panel } from './components';
import { ManualPostText } from './manual-post-text';

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

/**
 * `/plugins/example-plugin/manual-post` — 手動投稿の受け皿（設計 §9.8）。
 *
 * `manual()` が返した URL で子ウィンドウとして開かれる。
 * 本物の SNS の投稿画面にあたる位置で、**本文を見せるだけ。**
 * 投稿の成否は Torifune へ戻らない（Web Intent は結果を返さない）ので、
 * 「投稿した」は人が Torifune の画面で押す。
 */
export function ExampleManualPostPage() {
  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-4)' }}>
      <h1 style={{ fontSize: '1.25rem', margin: 0 }}>サンプルSNSへの投稿</h1>

      <Panel title="投稿する本文">
        <ManualPostText />
      </Panel>

      <Panel title="これは何か">
        <p style={{ margin: 0 }}>
          サンプルです。実際にはどこにも投稿されません。
          投稿し終えたら、とりふねの「手動投稿待ち」で「投稿した」を押してください。
        </p>
      </Panel>
    </div>
  );
}

/**
 * `/plugins/example-plugin/posts/<投稿ID>` — 配信済みの投稿の受け皿（設計 §9.8）。
 *
 * `publish()` が返した `externalUrl` の行き先。本物では SNS 側の投稿の URL になる。
 * **投稿 ID は `route` から取る。** 前方一致で引かれるので、末尾が要求された経路になる。
 */
export function ExamplePublishedPostPage(props: PluginPageProps) {
  const route = typeof props.route === 'string' ? props.route : '';
  const postId = route.split('/').pop() ?? '';

  return (
    <div style={{ display: 'grid', gap: 'var(--tf-space-4)' }}>
      <h1 style={{ fontSize: '1.25rem', margin: 0 }}>サンプルSNSの投稿</h1>

      <Panel title="投稿">
        <p style={{ margin: 0 }}>
          投稿ID: <code data-testid="example-published-post-id">{postId}</code>
        </p>
      </Panel>

      <Panel title="これは何か">
        <p style={{ margin: 0 }}>
          サンプルです。外部へは何も送られていません。ここは配信結果の
          <code>externalUrl</code> の行き先で、本物では SNS 側の投稿の URL になります。
        </p>
      </Panel>
    </div>
  );
}
