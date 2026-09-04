import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { loadSystemSettings } from '@/application/system-settings/system-settings-use-cases';
import './globals.css';

/**
 * 書体はリポジトリに同梱してセルフホストする（028 設計 §7.4.5、`app/fonts/README.md`）。
 *
 * **ビルド時にも実行時にも外部のフォント配信へ接続しない。**
 * 各 CSS 変数は `ui/tokens.css` の `--tf-font-sans` / `--tf-font-mono` が参照する。
 */
const inter = localFont({
  src: './fonts/Inter[wght].woff2',
  variable: '--font-inter',
  display: 'swap',
});

const jetBrainsMono = localFont({
  src: './fonts/JetBrainsMono[wght].woff2',
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

// ファイルが大きい。先読みして初回描画を待たせるより、出てから差し替えるほうが速い。
const notoSansJp = localFont({
  src: './fonts/NotoSansJP[wght].woff2',
  variable: '--font-noto-sans-jp',
  display: 'swap',
  preload: false,
});

/**
 * モバイルでの表示幅（06_画面設計.md §31）。
 *
 * **指定しないと、既定の980px幅として描かれてから縮小される。**
 * 文字が読めない大きさになり、`@media` も意図した断点で効かない。
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * タイトルは設定のサービス表示名を使う（06_画面設計.md §16）。
 *
 * **タブの並びで環境を見分けられるようにするため。**
 * 設定が読めないときは既定へ落ちる（`toSystemSettings`）。
 */
export async function generateMetadata(): Promise<Metadata> {
  const { serviceName } = await loadSystemSettings();
  return {
    title: serviceName,
    description: 'Torifune - マーケティング活動を一元管理するオープンソースアプリケーション',
  };
}

/**
 * すべてのページを動的描画にする（022-hardening）。
 *
 * **CSP を nonce 方式にしたため。** 静的に生成したページのHTMLには nonce が
 * 焼き込まれないのに、応答ヘッダにはリクエストごとの新しい nonce が載る。
 * その結果、そのページのスクリプトだけが全部ブロックされ、
 * **画面は出るのに操作できない**という壊れ方をする。実際に
 * `/password-reset` がその状態になった。
 *
 * ここに置くのは、ページごとに書くと必ず忘れるため。
 * 管理画面はもともとほぼ全ページが動的（セッションを見る）なので、
 * 静的生成を失う損は小さい。
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="ja"
      className={`${inter.variable} ${jetBrainsMono.variable} ${notoSansJp.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
