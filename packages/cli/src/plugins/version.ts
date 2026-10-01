/**
 * Plugin の版の前後関係（docs/設計/050-bundled-plugin-sync/設計.md §4・§6.3）。
 *
 * 同期が、印の無い古い Volume の同梱 Plugin を版番号で補って判定するときに使う。
 * CLI は本体（`apps/web`）に依存しないので、`apps/web/src/domain/plugin/version-order.ts` と
 * **同じ規則**のものをここに置く。両者が一致することは `apps/web` 側のテストで確かめる。
 */

/** `1.2.3` を数値の組にする。数字以外は 0 として扱う。 */
function parts(version: string): readonly number[] {
  return version
    .trim()
    .split('.')
    .map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    });
}

/**
 * `a` が `b` より新しければ 1、古ければ -1、同じなら 0。
 *
 * 桁数が違う場合（`1.2` と `1.2.0`）は足りない側を 0 として比べる。
 */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}
