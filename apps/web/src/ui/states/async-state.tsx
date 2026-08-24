'use client';

import type { ReactNode } from 'react';
import { Alert, Spinner } from '../components/primitives';
import { EmptyState } from '../components/overlays';

/**
 * Loading / Empty / Error / 権限なし の4状態（06_画面設計.md §35）。
 *
 * **最初から用意する。** 後から差し込むのが最も高くつく。
 */

export type AsyncStatus = 'loading' | 'empty' | 'error' | 'forbidden' | 'ready';

export interface AsyncStateProps {
  readonly status: AsyncStatus;
  /** エラー時に出す文言。**内部例外の詳細を渡さない。** */
  readonly errorMessage?: string;
  readonly emptyMessage?: string;
  readonly emptyAction?: ReactNode;
  readonly children: ReactNode;
}

export function AsyncState({
  status,
  errorMessage,
  emptyMessage = 'まだ登録されていません。',
  emptyAction,
  children,
}: AsyncStateProps) {
  if (status === 'loading') {
    return <Spinner />;
  }

  if (status === 'forbidden') {
    // メニューを隠すだけでは認可にならない（06_画面設計.md §29）。
    // ここは「到達したが権限が無い」場合の表示。
    return <Alert tone="warning">この操作を行う権限がありません。</Alert>;
  }

  if (status === 'error') {
    return <Alert tone="danger">{errorMessage ?? 'エラーが発生しました。'}</Alert>;
  }

  if (status === 'empty') {
    return <EmptyState message={emptyMessage} action={emptyAction} />;
  }

  return <>{children}</>;
}
