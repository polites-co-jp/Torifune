'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * ナビゲーションの 1 項目。
 *
 * **選択中の判定だけのために Client Component にしている。** `app-shell.tsx` は
 * Server Component で現在のパスを知らない。見た目（ピル型・選択中の面）は
 * `globals.css` の `.tf-nav-link[aria-current="page"]` が受け持つ。
 */
export function NavLink({
  href,
  children,
}: {
  readonly href: string;
  readonly children: ReactNode;
}) {
  const pathname = usePathname();
  const path = href.split('?')[0] ?? href;
  const active = pathname === path || pathname.startsWith(`${path}/`);

  return (
    <Link href={href} className="tf-nav-link" aria-current={active ? 'page' : undefined}>
      {children}
    </Link>
  );
}
