/**
 * 手順書の中のリンクの解決（041-plugin-help-docs 設計 §7.3.4）。純関数。
 *
 * 結果は 3 つ：
 *
 * * `external`：http(s) の絶対 URL。新しいタブで開く
 * * `internal`：Torifune の中（本文の断片・`/` で始まるパス・宣言した `.md` への相対パス）。同じタブ
 * * `none`：リンクにしない（危ないスキーム・プロトコル相対・宣言していないファイル）
 *
 * **`node:path` を import しない。** `ui/` はクライアントからも使われうる。
 * POSIX の正規化は下の数行で自前に行う。
 */

export interface HelpLinkContext {
  readonly pluginId: string;
  /** いま描いている手順書の path（Manifest の値） */
  readonly currentPath: string;
  /** 同じ Plugin の宣言（id と path） */
  readonly docs: readonly { readonly id: string; readonly path: string }[];
}

export type ResolvedHelpLink =
  /** 新しいタブ */
  | { readonly kind: 'external'; readonly href: string }
  /** 同じタブ（Torifune の中） */
  | { readonly kind: 'internal'; readonly href: string }
  /** リンクにしない（文字だけ） */
  | { readonly kind: 'none' };

const NONE: ResolvedHelpLink = { kind: 'none' };

/** 見出しの `id` の前置き（`MarkdownView` の `rehype-slug` の `prefix` と同じ）。 */
export const HELP_HEADING_ID_PREFIX = 'help-';

// eslint-disable-next-line no-control-regex -- 制御文字を含むリンクを拒むための検査そのもの
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

const HTTP_SCHEME = /^https?:/i;

/** URL のスキーム（`javascript:`・`data:`・`mailto:` など）。 */
const ANY_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function fragmentHref(fragment: string): string {
  return `#${HELP_HEADING_ID_PREFIX}${safeDecode(fragment)}`;
}

/**
 * `baseDirectory`（`/` 区切り、末尾の `/` なし。ルートは `''`）を基準に `relative` を正規化する。
 * Plugin のフォルダの外へ出れば `null`。
 */
function normalizeRelative(baseDirectory: string, relative: string): string | null {
  const segments = baseDirectory === '' ? [] : baseDirectory.split('/');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

export function resolveHelpLink(href: string, context: HelpLinkContext): ResolvedHelpLink {
  const value = href.trim();
  if (value === '' || CONTROL_CHARACTERS.test(value)) {
    return NONE;
  }

  if (HTTP_SCHEME.test(value)) {
    try {
      const url = new URL(value);
      return url.host === '' ? NONE : { kind: 'external', href: url.href };
    } catch {
      return NONE;
    }
  }

  if (value.startsWith('#')) {
    return { kind: 'internal', href: fragmentHref(value.slice(1)) };
  }

  // プロトコル相対（ブラウザは `/\` も `//` と同じに扱う）。
  if (value.startsWith('//') || value.startsWith('/\\')) {
    return NONE;
  }

  if (value.startsWith('/')) {
    return { kind: 'internal', href: value };
  }

  if (ANY_SCHEME.test(value)) {
    return NONE;
  }

  // 相対パス。宣言した `.md` と一致するものだけをリンクにする。
  const hashIndex = value.indexOf('#');
  const pathPart = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? null : value.slice(hashIndex + 1);
  if (pathPart === '' || pathPart.includes('\\')) {
    return NONE;
  }

  const normalized = normalizeRelative(directoryOf(context.currentPath), safeDecode(pathPart));
  if (normalized === null) {
    return NONE;
  }
  const doc = context.docs.find((candidate) => candidate.path === normalized);
  if (doc === undefined) {
    return NONE;
  }

  const target = `/plugins/${context.pluginId}/help/${doc.id}`;
  return {
    kind: 'internal',
    href: fragment === null || fragment === '' ? target : `${target}${fragmentHref(fragment)}`,
  };
}
