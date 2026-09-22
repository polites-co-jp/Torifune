'use client';

import { useEffect, useState } from 'react';

/**
 * 手動投稿の受け皿に渡ってきた本文。
 *
 * **Client Component にしているのは、URL のクエリを読むため。**
 * Plugin のページに渡るのは `pluginId` / `route` / `data` の3つで、
 * クエリは渡らない（`06_画面設計.md` §20 の catch-all）。
 *
 * 本物の SNS では、ここが X / Bluesky の投稿画面にあたる。
 * `?text=` に本文が入った状態で開く（Web Intent）のは同じ形である。
 */
export function ManualPostText() {
  // 初回描画では読まない。サーバー側に `window` は無く、
  // 違うものを描くと hydration が食い違う。
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    setText(new URLSearchParams(window.location.search).get('text') ?? '');
  }, []);

  if (text === null) {
    return <p style={{ margin: 0, color: 'var(--tf-color-text-muted)' }}>読み込んでいます…</p>;
  }

  return (
    <p style={{ margin: 0, whiteSpace: 'pre-wrap' }} data-testid="example-manual-post-text">
      {text}
    </p>
  );
}
