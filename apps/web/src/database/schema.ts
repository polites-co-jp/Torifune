import type { ColumnType, Generated, JSONColumnType } from 'kysely';

/**
 * Torifune のテーブル定義（Kysely 用）。
 *
 * `migrations/` の連番SQL が正であり、この型はそれに追随する手書きの写し。
 * 型定義から SQL を生成する方式は採らない（D-04：連番SQL を正とする）。
 * マイグレーションを足したら、この型も同じコミットで更新すること。
 */

/** DB が既定値を入れるため、INSERT では省略できる timestamptz。 */
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type UpdatedAt = ColumnType<Date, Date | string | undefined, Date | string>;

export interface UsersTable {
  id: string;
  login_id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  status: Generated<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  last_login_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface RolesTable {
  id: string;
  name: string;
  display_name: string;
  is_system: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface PermissionsTable {
  name: string;
  display_name: string;
  description: Generated<string>;
  is_system: Generated<boolean>;
  created_at: CreatedAt;
}

export interface UserRolesTable {
  user_id: string;
  role_id: string;
}

export interface RolePermissionsTable {
  role_id: string;
  permission_name: string;
}

export interface SessionsTable {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: CreatedAt;
  last_accessed_at: ColumnType<Date, Date | string | undefined, Date | string>;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  revoked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  ip_address: string | null;
  user_agent: string | null;
}

export interface AuthAuditLogsTable {
  id: string;
  event: string;
  user_id: string | null;
  login_id_attempted: string | null;
  ip_address: string | null;
  user_agent: string | null;
  /** パスワード・トークン・Cookie を入れてはならない（04_認証設計.md §26）。 */
  detail: JSONColumnType<Record<string, unknown>, string | undefined, string>;
  occurred_at: CreatedAt;
}

/**
 * 一般API操作の監査ログ（05_API設計.md §42）。
 *
 * `auth_audit_logs` とは別にする。理由は docs/設計/022-hardening/設計.md §3.1。
 */
export interface AuditLogsTable {
  id: string;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  /** パスワード・トークン・Cookie を入れてはならない。 */
  detail: JSONColumnType<Record<string, unknown>, string | undefined, string>;
  ip_address: string | null;
  user_agent: string | null;
  occurred_at: CreatedAt;
}

/** API Token（05_API設計.md §37-38）。設計は docs/設計/021-api-token/。 */
export interface ApiTokensTable {
  id: string;
  user_id: string;
  name: string;
  /** 平文は保存しない。SHA-256 のみ。 */
  token_hash: string;
  /** 一覧で見分けるための先頭部分。これだけでは認証に使えない。 */
  prefix: string;
  scopes: string[];
  expires_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  last_used_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  revoked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: CreatedAt;
}

/** システム設定（06_画面設計.md §16）。設計は docs/設計/015b-settings/。 */
export interface SystemSettingsTable {
  key: string;
  /** plugin_store と同じ扱い。任意の JSON を入れるため object に限定しない。 */
  value: ColumnType<unknown, string, string>;
  updated_at: UpdatedAt;
}

export interface SitesTable {
  id: string;
  name: string;
  url: string;
  /** 計測タグがサイトを識別する公開キー（018-analytics）。 */
  public_key: Generated<string>;
  description: Generated<string>;
  status: Generated<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  created_by: string | null;
}

/** キャンペーン（02_データベース設計.md §5.7）。設計は docs/設計/017-campaigns/。 */
export interface CampaignsTable {
  id: string;
  name: string;
  description: Generated<string>;
  status: Generated<string>;
  /** date 型。タイムゾーンで1日ずれないよう、文字列として扱う。 */
  starts_on: ColumnType<Date | string, Date | string, Date | string>;
  ends_on: ColumnType<Date | string | null, Date | string | null | undefined, Date | string | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  created_by: string | null;
}

export interface CampaignSitesTable {
  campaign_id: string;
  site_id: string;
}

/** アクセスの生ログ（02_データベース設計.md §5.8）。設計は docs/設計/018-analytics/。 */
export interface AccessLogsTable {
  id: string;
  site_id: string;
  occurred_at: CreatedAt;
  path: string;
  referrer_host: string | null;
  /** IP と User-Agent の生値は保存しない。日ごとのソルト付きハッシュ。 */
  visitor_hash: string;
  device: Generated<string>;
}

/** 日次の集計値。Core の集計と Plugin が取り込んだ値の両方が入る。 */
export interface AnalyticsTable {
  site_id: string;
  metric_date: ColumnType<Date | string, Date | string, Date | string>;
  source: Generated<string>;
  metric: string;
  value: Generated<number | bigint | string>;
  updated_at: UpdatedAt;
}

export interface SocialAccountsTable {
  id: string;
  provider: string;
  display_name: string;
  handle: Generated<string>;
  /** **暗号化済みの文字列**。平文を入れてはならない。 */
  credential: string | null;
  status: Generated<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface SocialPostsTable {
  id: string;
  social_account_id: string;
  body: string;
  scheduled_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  status: Generated<string>;
  published_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  failure_reason: string | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface PluginsTable {
  id: string;
  version: string;
  status: Generated<string>;
  installed_at: CreatedAt;
  /** install() フックを呼んだ時刻。null なら未実行（020-plugin-registry 設計 §2.5）。 */
  installed_hook_at: ColumnType<
    Date | null,
    Date | string | null | undefined,
    Date | string | null
  >;
  enabled_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  updated_at: UpdatedAt;
}

export interface PluginStoreTable {
  plugin_id: string;
  key: string;
  value: ColumnType<unknown, string, string>;
  /** 真なら value は暗号化した文字列。get() では取り出せない。 */
  is_secret: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface PluginOperationsTable {
  id: string;
  plugin_id: string;
  kind: string;
  status: Generated<string>;
  message: string | null;
  requested_by: string;
  started_at: CreatedAt;
  finished_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface PasswordResetTokensTable {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: ColumnType<Date, Date | string, Date | string>;
  used_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: CreatedAt;
}

export interface LoginAttemptsTable {
  id: string;
  /** 'ip:1.2.3.4' / 'login:alice' の形式。 */
  key: string;
  occurred_at: CreatedAt;
}

export interface SchemaMigrationsTable {
  version: string;
  name: string;
  checksum: string;
  applied_at: CreatedAt;
  execution_ms: number;
}

export interface Schema {
  users: UsersTable;
  sites: SitesTable;
  campaigns: CampaignsTable;
  campaign_sites: CampaignSitesTable;
  access_logs: AccessLogsTable;
  analytics: AnalyticsTable;
  social_accounts: SocialAccountsTable;
  social_posts: SocialPostsTable;
  plugins: PluginsTable;
  plugin_store: PluginStoreTable;
  plugin_operations: PluginOperationsTable;
  roles: RolesTable;
  permissions: PermissionsTable;
  user_roles: UserRolesTable;
  role_permissions: RolePermissionsTable;
  sessions: SessionsTable;
  auth_audit_logs: AuthAuditLogsTable;
  audit_logs: AuditLogsTable;
  api_tokens: ApiTokensTable;
  system_settings: SystemSettingsTable;
  password_reset_tokens: PasswordResetTokensTable;
  login_attempts: LoginAttemptsTable;
  schema_migrations: SchemaMigrationsTable;
}
