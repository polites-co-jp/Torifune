import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 送信待ちタブの画面の組み立ての静的検査（055-social-pending-tab 設計 §13.7、受け入れ条件 #37・#38）。
 *
 * * #37：承認待ち・手動投稿待ちの区画のファイル（`ui/social/approval-pending.tsx`・`manual-pending.tsx`）が無い。
 *   `app/social/page.tsx` が区画のための UseCase（`listApprovalPendingPosts`・`listManualPendingPosts`）を import しない
 *   （送信待ちは `listSocialPendingPosts` の 1 つの表。ユーザー裁定 3、設計 §5.2・§9.3）
 * * #38 のうち 055 で足す分：`app/social/history/page.tsx` は `redirect` を `next/navigation` から値として import して呼ぶ。
 *   転送はセッションを見ずに行う（`requirePageSession` を呼ばない。設計 §9.7・§9.12）
 *
 * `page.tsx` の 3 つの `normalizePage(params['…'])` と `history/page.tsx` の `normalizePage(params['page'])` は
 * `application/page-param-static-checks.test.ts` #17 が見る（`SCREENS` に `pendingPage`・`historyPage` を足した）。
 *
 * 述語はコメントを落としたソースに掛け、判別力として違反を 1 つ足した写しの文字列で落ちることを同じファイルで見る
 * （054 の静的検査と同じ流儀。実装プラン §2「テストの方法」）。
 */

/** apps/web/src/application/social → apps/web/src */
const SRC_DIR = join(import.meta.dirname, '..', '..');

function pathOf(...segments: string[]): string {
  return join(SRC_DIR, ...segments);
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

/** ファイルを読む（無ければ落とす）。コメントを落として返す。 */
function readSource(label: string): string {
  const path = pathOf(...label.split('/'));
  expect(existsSync(path), `${label} が無い`).toBe(true);
  return withoutComments(readFileSync(path, 'utf8'));
}

/** `name` をどこかから import しているか（`import type` も含む）。 */
function importsName(source: string, name: string): boolean {
  const pattern = new RegExp(
    `import\\s+(?:type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"][^'"]+['"]`,
  );
  return pattern.test(source);
}

/** `name` を `module` から**値として**import しているか（`import type` は認めない）。 */
function importsValueFrom(source: string, name: string, module: string): boolean {
  const escaped = module.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const pattern = new RegExp(
    `import\\s*\\{[^}]*(?<!type\\s)\\b${name}\\b[^}]*\\}\\s*from\\s*['"]${escaped}['"]`,
  );
  return pattern.test(source);
}

/** `name(` の呼び出しがあるか。 */
function calls(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(source);
}

const SECTION_FILES = ['ui/social/approval-pending.tsx', 'ui/social/manual-pending.tsx'] as const;
const SECTION_USE_CASES = ['listApprovalPendingPosts', 'listManualPendingPosts'] as const;

describe('#37 承認待ち・手動投稿待ちの区画が無い', () => {
  it.each(SECTION_FILES)('#37 %s が無い', (file) => {
    expect(existsSync(pathOf(...file.split('/'))), `${file} が残っている`).toBe(false);
  });

  it('#37 送信待ちの表の部品（ui/social/social-pending.tsx）はある（空振りで緑にしない）', () => {
    expect(existsSync(pathOf('ui', 'social', 'social-pending.tsx'))).toBe(true);
  });

  it.each(SECTION_USE_CASES)('#37 app/social/page.tsx が %s を import しない', (name) => {
    const source = readSource('app/social/page.tsx');

    expect(importsName(source, name)).toBe(false);
  });

  it('#37 app/social/page.tsx は送信待ちの一覧 listSocialPendingPosts を import する（空振りで緑にしない）', () => {
    const source = readSource('app/social/page.tsx');

    expect(importsName(source, 'listSocialPendingPosts')).toBe(true);
  });

  it('#37 判別力：区画の UseCase を import した写しは述語が落とす', () => {
    for (const name of SECTION_USE_CASES) {
      const copy = `import {\n  listSocialPosts,\n  ${name},\n} from '@/application/social/social-use-cases';\n`;
      expect(importsName(copy, name)).toBe(true);
      expect(
        importsName(
          `import { listSocialPosts } from '@/application/social/social-use-cases';`,
          name,
        ),
      ).toBe(false);
    }
  });
});

describe('#38 /social/history は配信履歴タブへの転送だけ', () => {
  it('#38 app/social/history/page.tsx は redirect を next/navigation から値として import する', () => {
    const source = readSource('app/social/history/page.tsx');

    expect(importsValueFrom(source, 'redirect', 'next/navigation')).toBe(true);
  });

  it('#38 app/social/history/page.tsx は redirect( を呼ぶ', () => {
    const source = readSource('app/social/history/page.tsx');

    expect(calls(source, 'redirect')).toBe(true);
  });

  it('#38 app/social/history/page.tsx はセッションを見ない（requirePageSession を呼ばない）', () => {
    const source = readSource('app/social/history/page.tsx');

    expect(calls(source, 'requirePageSession')).toBe(false);
  });

  it('#38 app/social/history/page.tsx は配信履歴を描かない（SocialHistory・listSocialPostHistory を使わない）', () => {
    const source = readSource('app/social/history/page.tsx');

    expect(importsName(source, 'SocialHistory')).toBe(false);
    expect(importsName(source, 'listSocialPostHistory')).toBe(false);
  });

  it('#38 判別力：import type だけの写し・呼ばない写しは述語が落とす', () => {
    const typeOnly = `import type { redirect } from 'next/navigation';\nexport default function Page() { return null; }`;
    const other = `import { notFound } from 'next/navigation';\nnotFound();`;
    const good = `import { redirect } from 'next/navigation';\nredirect('/social?tab=history');`;

    expect(importsValueFrom(typeOnly, 'redirect', 'next/navigation')).toBe(false);
    expect(importsValueFrom(other, 'redirect', 'next/navigation')).toBe(false);
    expect(calls(other, 'redirect')).toBe(false);
    expect(importsValueFrom(good, 'redirect', 'next/navigation')).toBe(true);
    expect(calls(good, 'redirect')).toBe(true);
    expect(calls(`const session = await requirePageSession();`, 'requirePageSession')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #84 行ごとの handoff の解決を settleManualHandoff で包む（設計 §8.3・§9.12・§13.12。検証 1 回目 security S1）
// ---------------------------------------------------------------------------

/** `resolveManualHandoff(` の呼び出しがすべて `settleManualHandoff(` の直下にあるか。 */
function everyHandoffIsSettled(source: string): boolean {
  const all = source.match(/\bresolveManualHandoff\s*\(/g) ?? [];
  const settled = source.match(/\bsettleManualHandoff\s*\(\s*resolveManualHandoff\s*\(/g) ?? [];
  return all.length > 0 && all.length === settled.length;
}

describe('#84 app/social/page.tsx は行ごとの resolveManualHandoff を settleManualHandoff で包む', () => {
  it('#84 settleManualHandoff を @/application/social/manual-handoff-settle から値として import する', () => {
    const source = readSource('app/social/page.tsx');

    expect(
      importsValueFrom(source, 'settleManualHandoff', '@/application/social/manual-handoff-settle'),
    ).toBe(true);
  });

  it('#84 resolveManualHandoff( の呼び出しはすべて settleManualHandoff( で包まれている', () => {
    expect(everyHandoffIsSettled(readSource('app/social/page.tsx'))).toBe(true);
  });

  it('#84 判別力：包まない呼び出しが 1 つ残る写し・呼び出しの無い写しは通らない', () => {
    const wrapped =
      'settleManualHandoff(resolveManualHandoff(context, { id, deadline: handoffDeadline }))';
    const bare = 'resolveManualHandoff(context, { id, deadline: handoffDeadline })';

    expect(everyHandoffIsSettled(wrapped)).toBe(true);
    expect(everyHandoffIsSettled(`${wrapped}\n${bare}`)).toBe(false);
    expect(everyHandoffIsSettled(bare)).toBe(false);
    expect(everyHandoffIsSettled('')).toBe(false);
  });
});
