import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'とりふね',
  description: 'Torifune - マーケティング活動を一元管理するオープンソースアプリケーション',
};

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
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
