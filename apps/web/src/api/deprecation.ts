/**
 * エンドポイントの非推奨（Deprecated）（05_API設計.md §41）。
 *
 * §41 は互換性を壊す変更の手順として
 * 「新しい Version を出す → 旧 Version を一定期間維持する → **非推奨として告知する**
 * → 移行方法を文書化する」を挙げている。
 * 告知の口が無いと、この手順は「口頭で伝える」以上のものにならない。
 *
 * ここでは告知を**定義の一部**にする。`defineRoute` に `deprecated` を書けば、
 * OpenAPI にも応答ヘッダにも同じ内容が出る。書き忘れと書きずれが起きない。
 */

export interface DeprecationNotice {
  /** 非推奨になった日（`YYYY-MM-DD`）。将来の日付なら「その日から非推奨」を意味する。 */
  readonly since: string;
  /**
   * 代替のエンドポイント（`/analytics` のような `/api/v1` 配下のパス）。
   *
   * **移行先が無いなら書かない。** 「代わりが無い」ことも情報である。
   */
  readonly replacedBy?: string;
  /**
   * この日以降に削除する（`YYYY-MM-DD`）。
   *
   * §41 の「旧Versionを一定期間維持する」を具体的な日付にしたもの。
   * 未定なら書かない。**適当な日付を置かない。**
   */
  readonly removeAfter?: string;
}

export class DeprecationNoticeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeprecationNoticeError';
  }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` を UTC の 00:00:00 として読む。実在しない日付は null。 */
function parseDateOnly(value: string): Date | null {
  if (!DATE_ONLY.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  // `2026-02-31` のような実在しない日付は Date が繰り上げてしまうので、往復で確かめる。
  return parsed.toISOString().slice(0, 10) === value ? parsed : null;
}

/**
 * 非推奨の告知として成立しているかを確かめる。
 *
 * **不正なら例外にする。** 黙って無視すると、告知したつもりのまま告知されない。
 */
export function assertValidDeprecation(operationId: string, notice: DeprecationNotice): void {
  const since = parseDateOnly(notice.since);
  if (since === null) {
    throw new DeprecationNoticeError(
      `${operationId}: deprecated.since は YYYY-MM-DD の実在する日付にする`,
    );
  }

  if (notice.removeAfter !== undefined) {
    const removeAfter = parseDateOnly(notice.removeAfter);
    if (removeAfter === null) {
      throw new DeprecationNoticeError(
        `${operationId}: deprecated.removeAfter は YYYY-MM-DD の実在する日付にする`,
      );
    }
    if (removeAfter.getTime() < since.getTime()) {
      // 「非推奨になる前に消える」は、利用者が移行できる期間が無いということ。
      throw new DeprecationNoticeError(
        `${operationId}: deprecated.removeAfter は since 以降にする`,
      );
    }
  }

  if (notice.replacedBy !== undefined && !notice.replacedBy.startsWith('/')) {
    throw new DeprecationNoticeError(
      `${operationId}: deprecated.replacedBy は /users のようなパスで書く`,
    );
  }
}

/**
 * 応答に付ける非推奨ヘッダ。
 *
 * **付ける。** 理由は次のとおり。
 *
 * OpenAPI（§40）の `deprecated: true` は、仕様書を読み直した人にしか届かない。
 * 既に組み終わったクライアントは仕様書を取り直さないので、
 * 「動いているうちは気づかず、削除された日に初めて壊れる」ことになる。
 * §41 が求めているのは告知であって、告知は**動いている呼び出しへ届く**必要がある。
 * 応答ヘッダなら、ログにも監視にも自然に残る。
 *
 * 形式は標準に合わせ、独自ヘッダを作らない。
 *
 * * `Deprecation`（RFC 9745）: 構造化フィールドの Date。`@` + Unix 秒。
 * * `Sunset`（RFC 8594）: HTTP-date。削除予定日が決まっているときだけ出す。
 * * `Link`: 代替があるとき `rel="successor-version"`（RFC 5829）で指す。
 *
 * 本文には入れない。**応答の形（`{ data }` / `{ error }`）を非推奨かどうかで変えない。**
 * 変えると、クライアントは非推奨を意識した分岐を書く羽目になる。
 */
export function deprecationHeaders(
  notice: DeprecationNotice,
  basePath = '/api/v1',
): Record<string, string> {
  const since = parseDateOnly(notice.since);
  if (since === null) {
    // 定義時に検証済み。ここへ来るのは検証を通さずに呼んだときだけ。
    return {};
  }

  const headers: Record<string, string> = {
    Deprecation: `@${Math.floor(since.getTime() / 1000)}`,
  };

  const removeAfter = notice.removeAfter === undefined ? null : parseDateOnly(notice.removeAfter);
  if (removeAfter !== null) {
    headers['Sunset'] = removeAfter.toUTCString();
  }

  if (notice.replacedBy !== undefined) {
    headers['Link'] = `<${basePath}${notice.replacedBy}>; rel="successor-version"`;
  }

  return headers;
}

/** OpenAPI の説明に足す一文。仕様書とヘッダで同じことを言う。 */
export function deprecationDescription(notice: DeprecationNotice): string {
  const parts = [`${notice.since} から非推奨。`];
  if (notice.replacedBy !== undefined) {
    parts.push(`${notice.replacedBy} へ移行すること。`);
  }
  if (notice.removeAfter !== undefined) {
    parts.push(`${notice.removeAfter} 以降に削除する。`);
  } else {
    parts.push('削除予定日は未定。');
  }
  return parts.join(' ');
}
