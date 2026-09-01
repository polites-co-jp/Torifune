/**
 * Plugin のバージョンの前後関係（020-plugin-registry 設計 §2.4）。
 *
 * **Domain 層。** 更新のときに「版が上がっているか」を判定するために使う。
 *
 * `dependencies.ts` の `satisfiesVersion` は「範囲に入るか」を見るもので、
 * 「どちらが新しいか」は答えない。用途が違うので分けている。
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
 * `a` が `b` より新しければ正、古ければ負、同じなら 0。
 *
 * 桁数が違う場合（`1.2` と `1.2.0`）は足りない側を 0 として比べる。
 * `1.2` と `1.2.0` は同じ版として扱う。
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

export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}
