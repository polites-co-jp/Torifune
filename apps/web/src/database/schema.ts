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

export interface SitesTable {
  id: string;
  name: string;
  url: string;
  description: Generated<string>;
  status: Generated<string>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
  created_by: string | null;
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
  password_reset_tokens: PasswordResetTokensTable;
  login_attempts: LoginAttemptsTable;
  schema_migrations: SchemaMigrationsTable;
}
