import { sanitizeAuditDetail } from './auth-audit';

/**
 * 一般API操作の監査ログ（05_API設計.md §42）。
 *
 * 認証・認可のセキュリティログ（`auth-audit.ts`、04_認証設計.md §26）とは分ける。
 * **1本にまとめない。** 読み手が違い（侵害調査 / 操作の追跡）、
 * イベント名の集合を共有すると片方の都合でもう片方が歪む。
 * 理由は docs/設計/022-hardening/設計.md §3.1。
 *
 * **詳細情報にパスワード・トークン・Cookie を入れてはならない。**
 * `sanitizeAuditDetail` が機械的に落とす。
 */

/** 何をしたか。 */
export const AUDIT_ACTIONS = [
  'created',
  'updated',
  'deleted',
  'enabled',
  'disabled',
  'installed',
  'uninstalled',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** 何に対してか。Core が持つリソースの種類。 */
export const AUDIT_RESOURCE_TYPES = [
  'site',
  'campaign',
  'social_account',
  'social_post',
  'plugin',
  'plugin_settings',
  'api_token',
  'system_settings',
  'webhook',
] as const;

export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

export interface AuditEntry {
  readonly id: string;
  /** 操作した人。システムによる操作なら null。 */
  readonly actorUserId: string | null;
  readonly action: AuditAction;
  readonly resourceType: AuditResourceType;
  /** Plugin ID のように uuid でないものもある。 */
  readonly resourceId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly detail: Record<string, unknown>;
}

export interface AuditRepository {
  record(tx: unknown, entry: AuditEntry): Promise<void>;
}

/** 詳細情報の整形。認証側と同じ規則を使う（機密キーを二重管理しない）。 */
export { sanitizeAuditDetail };
