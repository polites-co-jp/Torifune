'use client';

import type { ReactNode } from 'react';

/**
 * Permission を持つときだけ描画する。
 *
 * **これは認可ではない**（06_画面設計.md §29）。
 *
 * 画面から要素を隠すのは、使えない操作を見せないための配慮にすぎない。
 * URL を直接叩けば同じ処理へ到達できるため、**サーバー側の検証が本体**。
 * 認可は Application 層の `requirePermission` が行っている。
 *
 * ここを認可の代わりに使ってはならない。
 */
export function PermissionGate({
  permissions,
  required,
  children,
  fallback = null,
}: {
  readonly permissions: ReadonlySet<string>;
  readonly required: string;
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
}): ReactNode {
  return permissions.has(required) ? children : fallback;
}
