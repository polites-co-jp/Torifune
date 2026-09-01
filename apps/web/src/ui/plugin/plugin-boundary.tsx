'use client';

import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { log } from '@/infrastructure/logging';

/**
 * Plugin の描画が例外を投げたときに、その枠だけを落とす
 * （`03_リスクと未決事項.md` S-4、`011-plugin-runtime` の残した課題 #1）。
 *
 * **これが無いと、Plugin ひとつの不具合で画面が丸ごと白くなる。**
 * Plugin は信頼されたコードとして扱うが、信頼と無謬は別のことである。
 *
 * Plugin の部品は Server Component のまま描画してよい。
 * App Router では Server Component が投げた例外も RSC の応答へ載り、
 * クライアント側の最も近い Error Boundary で捕まる（`error.tsx` と同じ仕組み）。
 * **Plugin 作者に「Client Component で書くこと」を要求しない。**
 *
 * `children` として受け取るだけなので、Plugin の部品へ渡す
 * Data API（関数を持つ）はサーバー側に留まる。
 */

export interface PluginBoundaryProps {
  readonly pluginId: string;
  /** 何が落ちたか。「ウィジェット」「拡張」など。利用者向けの言葉にする。 */
  readonly label: string;
  readonly children: ReactNode;
}

interface PluginBoundaryState {
  readonly failed: boolean;
}

export class PluginBoundary extends Component<PluginBoundaryProps, PluginBoundaryState> {
  override state: PluginBoundaryState = { failed: false };

  static getDerivedStateFromError(): PluginBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // **利用者には出さない。** 内部の詳細はログにだけ残す。
    log.error('plugin render failed', {
      pluginId: this.props.pluginId,
      reason: error.message,
      componentStack: info.componentStack,
    });
  }

  override render(): ReactNode {
    if (!this.state.failed) {
      // **Suspense が要る。** これが無いと、Plugin の描画が投げたときに
      // ページ全体の描画が中断され、500 になる（枠だけ落ちない）。
      // Suspense があると、本体の骨組みを先に送ってから Plugin の枠を流し込むため、
      // 失敗をこの枠の中で受け取れる。
      return (
        // 名前空間の囲い（07_開発者向けガイド.md §31）。
        // Plugin の CSS はこの属性へ閉じたセレクタで書く（`pluginScope()`）。
        // **隔離ではない。** Plugin は本体と同じ React ツリーで動くことが前提で、
        // iframe や Shadow DOM で隔離すると共通コンポーネントも拡張点も使えなくなる。
        // 事故を減らす仕組みであって、悪意を止める仕組みではない。
        <div data-torifune-plugin={this.props.pluginId} style={{ display: 'contents' }}>
          <Suspense fallback={null}>{this.props.children}</Suspense>
        </div>
      );
    }

    return (
      <div
        role="alert"
        data-plugin-error={this.props.pluginId}
        style={{
          border: '1px solid var(--tf-color-border)',
          borderLeft: '3px solid var(--tf-color-warning)',
          borderRadius: 'var(--tf-radius-md)',
          padding: 'var(--tf-space-4)',
          color: 'var(--tf-color-text-muted)',
          background: 'var(--tf-color-surface)',
        }}
      >
        {/*
          どの Plugin が壊れたかは出す。出さないと、利用者は本体の不具合だと考える。
          例外の内容は出さない（`06_画面設計.md` §34）。
        */}
        プラグイン「{this.props.pluginId}」の{this.props.label}を表示できませんでした。
      </div>
    );
  }
}
