import { log } from '@/infrastructure/logging';

/**
 * Plugin Registry のクライアント（03_プラグイン設計.md §14.1 §15）。
 *
 * **中央のサービスを作らない。** OSS 本体が特定の配布元へ依存すると、
 * `CLAUDE.md` の「特定のクラウド／SaaS運営基盤への依存」に触れる。
 *
 * 代わりに **HTTPS で取れる JSON を Registry と定義する**（設計 §2.1）。
 * 静的ファイルで足りるので、誰でも自前の Registry を置ける。
 */

export interface RegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string | null;
  readonly downloadUrl: string;
  /** 配布物の SHA-256（16進）。 */
  readonly sha256: string;
  /** ed25519 署名（base64）。署名の対象は sha256 の文字列。 */
  readonly signature: string;
  /** 配布元。画面に出して、誰のものかを見せる。 */
  readonly publisher: string | null;
  /**
   * 対応する Plugin API のバージョン（03_プラグイン設計.md §15 §16）。
   *
   * **これが無いと、zip を落として展開するまで互換性を判断できない。**
   * 宣言していない Registry もあるので、分からなければ null。
   */
  readonly apiVersion: number | null;
  /** 依存する Plugin（同 §15 §17）。宣言が無ければ空。 */
  readonly dependencies: Readonly<Record<string, string>>;
  /** 対応する Torifune のバージョン範囲（同 §15）。 */
  readonly torifuneVersion: string | null;
  /** 配布物の更新日時（同 §15）。ISO 8601。 */
  readonly updatedAt: string | null;
  /**
   * 要求する Permission（同 §20.2、06_画面設計.md §39）。
   *
   * **「要求しない」と「宣言していない」を混ぜない。** 宣言が無ければ null。
   * 空配列にすると、画面で「権限は要りません」と言い切ってしまう。
   * 確定するのは導入時の Manifest 検証であり、ここは押す前の目安。
   */
  readonly permissions: readonly string[] | null;
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_configured' | 'unreachable' | 'malformed' | 'not_found' | 'insecure_url',
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

export function registryUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const raw = env['TORIFUNE_PLUGIN_REGISTRY_URL']?.trim();
  return raw === undefined || raw === '' ? null : raw;
}

/**
 * 取得してよい URL か。
 *
 * **HTTPS に限る。** HTTP だと配布物を途中で差し替えられる。
 * 署名で改竄は検出できるが、**署名の無いものを掴まされる余地**を残さない。
 * 開発用の localhost だけは HTTP を許す。
 */
export function isFetchableUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/** 読めなかった印。「宣言されていない（null）」と区別する。 */
const BROKEN = Symbol('broken');

/**
 * 宣言されていない項目は null、宣言されているが形が違う項目は `BROKEN`。
 *
 * **値があるのに形が違うものを推測しない。** 「不明」に丸めると、
 * 合わない Plugin を「判定できないだけ」に見せてしまう。
 */
function optional<T>(value: unknown, read: (raw: unknown) => T | null): T | null | typeof BROKEN {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = read(value);
  return parsed === null ? BROKEN : parsed;
}

function readApiVersion(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

function readDependencies(raw: unknown): Readonly<Record<string, string>> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const result: Record<string, string> = {};
  for (const [id, range] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof range !== 'string' || range.trim() === '') {
      return null;
    }
    result[id] = range;
  }
  return result;
}

function readTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }
  // 日時として読めないものを画面へ流さない。
  return Number.isNaN(Date.parse(raw)) ? null : raw.trim();
}

function readPermissions(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  if (raw.some((item) => typeof item !== 'string' || item.trim() === '')) {
    return null;
  }
  return raw as readonly string[];
}

/** 1件を検証しながら読む。壊れた項目は落とす（全体を捨てない）。 */
function toEntry(raw: unknown): RegistryEntry | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const value = raw as Record<string, unknown>;

  const text = (key: string): string | null =>
    typeof value[key] === 'string' && value[key].trim() !== '' ? (value[key] as string) : null;

  const id = text('id');
  const name = text('name');
  const version = text('version');
  const downloadUrl = text('downloadUrl');
  const sha256 = text('sha256');
  const signature = text('signature');

  if (
    id === null ||
    name === null ||
    version === null ||
    downloadUrl === null ||
    sha256 === null ||
    signature === null
  ) {
    return null;
  }
  if (!isFetchableUrl(downloadUrl)) {
    return null;
  }

  // 03_プラグイン設計.md §15 が保持を求める項目。
  const apiVersion = optional(value['apiVersion'], readApiVersion);
  const dependencies = optional(value['dependencies'], readDependencies);
  const torifuneVersion = optional(value['torifuneVersion'], (item) =>
    typeof item === 'string' && item.trim() !== '' ? item.trim() : null,
  );
  const updatedAt = optional(value['updatedAt'], readTimestamp);
  const permissions = optional(value['permissions'], readPermissions);

  if (
    apiVersion === BROKEN ||
    dependencies === BROKEN ||
    torifuneVersion === BROKEN ||
    updatedAt === BROKEN ||
    permissions === BROKEN
  ) {
    return null;
  }

  return {
    id,
    name,
    version,
    description: text('description'),
    downloadUrl,
    sha256,
    signature,
    publisher: text('publisher'),
    apiVersion,
    dependencies: dependencies ?? {},
    torifuneVersion,
    updatedAt,
    permissions,
  };
}

/** JSON からインデックスを組み立てる。**取得と分けてある**のでテストしやすい。 */
export function parseRegistryIndex(payload: unknown): readonly RegistryEntry[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new RegistryError('Registry の形式が不正', 'malformed');
  }
  const plugins = (payload as { plugins?: unknown }).plugins;
  if (!Array.isArray(plugins)) {
    throw new RegistryError('Registry に plugins が無い', 'malformed');
  }

  const entries: RegistryEntry[] = [];
  for (const raw of plugins) {
    const entry = toEntry(raw);
    if (entry === null) {
      // 1件の不備で全体を捨てない。残りは使える。
      log.warn('registry entry skipped (malformed)', {});
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

/** 名前・ID・説明の部分一致で絞る。 */
export function searchEntries(
  entries: readonly RegistryEntry[],
  keyword: string,
): readonly RegistryEntry[] {
  const needle = keyword.trim().toLowerCase();
  if (needle === '') {
    return entries;
  }
  return entries.filter((entry) =>
    [entry.id, entry.name, entry.description ?? ''].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
}

/** 取得の上限。応答が大きすぎるものを読み込まない。 */
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithLimit(url: string, maxBytes: number): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  }).catch(() => {
    throw new RegistryError('Registry へ到達できない', 'unreachable');
  });

  if (!response.ok) {
    throw new RegistryError(`Registry が ${response.status} を返した`, 'unreachable');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new RegistryError('応答が大きすぎる', 'malformed');
  }
  return buffer;
}

export async function fetchRegistryIndex(url: string): Promise<readonly RegistryEntry[]> {
  if (!isFetchableUrl(url)) {
    throw new RegistryError('Registry の URL は https でなければならない', 'insecure_url');
  }

  const body = await fetchWithLimit(url, MAX_INDEX_BYTES);
  try {
    return parseRegistryIndex(JSON.parse(body.toString('utf8')));
  } catch (error) {
    if (error instanceof RegistryError) {
      throw error;
    }
    throw new RegistryError('Registry の JSON を読めない', 'malformed');
  }
}

export async function fetchPackage(entry: RegistryEntry): Promise<Buffer> {
  if (!isFetchableUrl(entry.downloadUrl)) {
    throw new RegistryError('配布物の URL は https でなければならない', 'insecure_url');
  }
  return fetchWithLimit(entry.downloadUrl, MAX_PACKAGE_BYTES);
}
