import { headers } from 'next/headers';
import { clientIpOf } from '@/api/cookies';
import { allowedOrigins } from '@/api/cors';
import { getAccessLogIpExclusions } from '@/application/analytics/ip-exclusion-use-cases';
import {
  analyticsTimeZoneSetting,
  resolveAnalyticsTimeZone,
} from '@/application/analytics/timezone';
import { listPermissions } from '@/application/authorization/permission-registry';
import { listJobStatuses } from '@/application/jobs/job-use-cases';
import { schedulerSnapshot } from '@/application/jobs/scheduler';
import { getSystemSettings } from '@/application/system-settings/system-settings-use-cases';
import { authenticationProviderId } from '@/authentication/registry';
import { listUsers } from '@/application/user/user-use-cases';
import { listRoleGrants, listRoles } from '@/application/authorization/role-use-cases';
import { formatDateTimeInTimeZone } from '@/domain/analytics/day';
import { normalizeClientIp } from '@/domain/analytics/ip-exclusion';
import { timeZoneOptions } from '@/domain/analytics/time-zone';
import { Tabs } from '@/ui/components';
import { JOB_LABEL, REBUILD_RETRY_NOTE, rebuildProgressText } from '@/ui/analytics/labels';
import { AppShell } from '@/ui/layout/app-shell';
import { ExtensionPoint } from '@/ui/plugin/plugin-slot';
import { requirePageSession } from '@/ui/server/page-session';
import { AccessLogIpSettings } from '@/ui/settings/access-log-ip-settings';
import { ApiSettings } from '@/ui/settings/api-settings';
import { AuthSettings } from '@/ui/settings/auth-settings';
import { GeneralSettings } from '@/ui/settings/general-settings';
import { JobStatusCard, type JobStatusCardData } from '@/ui/settings/job-status';
import { PermissionMatrix } from '@/ui/settings/permission-matrix';
import { TimeZoneSettings } from '@/ui/settings/timezone-settings';
import { UserList } from '@/ui/settings/user-list';
import { AsyncState } from '@/ui/states/async-state';

export const dynamic = 'force-dynamic';

/** 「直近のエラー」に並べる件数（設計 §7.2）。 */
const RECENT_ERROR_DISPLAY_LIMIT = 5;

/**
 * 設定画面（06_画面設計.md §16）。
 *
 * 一般 / ユーザー / 権限 / 認証 / API の5タブ（`015-settings` ＋ `015b-settings`）。
 * Plugin は別画面（`/plugins`）。
 *
 * **タブごとに要る権限が違う。** 画面全体を1つの権限で塞がない。
 * 一般・認証・API は認証さえしていれば見え、変更に `system.manage` が要る。
 * ユーザー・権限は `user.manage` が要る。
 *
 * **読み取りは Server Component から UseCase を直接呼ぶ**（決定事項 D-06）。
 * 認可は UseCase 側で行われる。
 */

const TAB_KEYS = ['general', 'users', 'permissions', 'auth', 'api'] as const;

type TabKey = (typeof TAB_KEYS)[number];

function toTab(value: string | string[] | undefined): TabKey {
  return (TAB_KEYS as readonly string[]).includes(String(value)) ? (value as TabKey) : 'general';
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { context, displayName, permissions } = await requirePageSession();

  const canManageUsers = permissions.has('user.manage');
  const canManageSystem = permissions.has('system.manage');
  const canManageTokens = permissions.has('token.manage');

  const requested = toTab(params['tab']);

  // **表示制御ではなく認可。** ナビを隠すだけでは止められない（同 §29-30）。
  // 見えないタブを URL で直接指しても中身を出さない。
  const allowed: Record<TabKey, boolean> = {
    general: true,
    users: canManageUsers,
    permissions: canManageUsers,
    auth: true,
    api: canManageTokens,
  };

  if (!allowed[requested]) {
    return (
      <AppShell displayName={displayName} permissions={permissions}>
        <AsyncState status="forbidden">{null}</AsyncState>
      </AppShell>
    );
  }

  const tab = requested;
  const page = Math.max(1, Number(params['page'] ?? 1) || 1);
  const perPage = 20;

  const roles = canManageUsers ? await listRoles(context, {}) : [];
  const settings = await getSystemSettings(context, {});

  return (
    <AppShell displayName={displayName} permissions={permissions}>
      <h1 style={{ fontSize: '1.25rem', marginTop: 0 }}>設定</h1>

      <Tabs
        label="設定のタブ"
        current={tab}
        hrefFor={(key) => `/settings?tab=${key}`}
        items={[
          { key: 'general', label: '一般' },
          { key: 'users', label: 'ユーザー', visible: canManageUsers },
          { key: 'permissions', label: '権限', visible: canManageUsers },
          { key: 'auth', label: '認証' },
          { key: 'api', label: 'API', visible: canManageTokens },
        ]}
      />

      {tab === 'general' && (
        <>
          <GeneralSettings settings={settings} canManage={canManageSystem} />
          {/*
            基準タイムゾーン（032 設計 §7.1）。**表示は誰でも、変更は `system.manage`。**
            表示制御であって認可ではない（認可は `analytics.timeZoneUpdate`）。
          */}
          <TimeZoneSection canManage={canManageSystem} />
          {/*
            アクセスログの除外IP（033 設計 §10）。**表示にも `system.manage` を要求する。**
            表示名・タイムゾーンと違い、**リストの表示自体が漏洩**である
            （社内の IP 帯・VPN の出口が書かれる）。出し分けは表示制御で、
            認可は `getAccessLogIpExclusions`（`system.manage`）が行う。
          */}
          {canManageSystem && <AccessLogIpSection context={context} />}
          {/*
            定期実行の状況（029 設計 §7.2）。**タブは足さない**（06 §16）。
            出し分けは表示制御で、認可は `listJobStatuses`（`system.manage`）が行う。
          */}
          {canManageSystem && <JobStatusSection context={context} />}
        </>
      )}
      {tab === 'users' && (
        <UsersTab context={context} page={page} perPage={perPage} roles={roles} />
      )}
      {tab === 'permissions' && <PermissionsTab context={context} roles={roles} />}
      {tab === 'auth' && (
        <AuthSettings
          settings={settings}
          canManage={canManageSystem}
          authProviderId={authenticationProviderId()}
        />
      )}
      {tab === 'api' && (
        <ApiSettings scopeCandidates={[...permissions].sort()} corsOrigins={allowedOrigins()} />
      )}

      {/*
        Plugin が追加するタブ（06_画面設計.md §27）。
        Core のタブの下に並べる。**Core のタブへ割り込ませない。**
      */}
      <div style={{ marginTop: 'var(--tf-space-6)' }}>
        <ExtensionPoint point="settings.tabs" permissions={permissions} context={context} />
      </div>
    </AppShell>
  );
}

type PageContext = Awaited<ReturnType<typeof requirePageSession>>['context'];
type RoleList = Awaited<ReturnType<typeof listRoles>>;

async function UsersTab({
  context,
  page,
  perPage,
  roles,
}: {
  context: PageContext;
  page: number;
  perPage: number;
  roles: RoleList;
}) {
  const result = await listUsers(context, {
    page,
    perPage,
    status: null,
    keyword: null,
    sort: [{ field: 'created_at', direction: 'desc' }],
  });

  return (
    <UserList
      initialUsers={result.items.map(({ user, roles: assigned }) => ({
        id: user.id,
        loginId: user.loginId,
        displayName: user.displayName,
        email: user.email,
        status: user.status,
        roles: [...assigned],
        lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      }))}
      availableRoles={roles.map((role) => ({
        id: role.id,
        name: role.name,
        displayName: role.displayName,
      }))}
      currentUserId={context.identity?.userId ?? ''}
      total={result.total}
      page={page}
      perPage={perPage}
    />
  );
}

/**
 * 基準タイムゾーンの区画（032 設計 §7.1）。
 *
 * **選択肢はここで組み立てる。** ブラウザ側の `Intl` 実装差・ICU の差が画面に出ないよう、
 * 一覧はサーバーで作って props で渡す（設計 §5.3.2）。
 * 保存済みの値が一覧に無い場合でも選択欄から消えないよう、現在値を `extra` に混ぜる。
 */
/**
 * アクセスログの除外IPの区画（033 設計 §10）。
 *
 * **現在のアクセス元 IP は `headers()` から取る。** 受け口（`requestInfoOf`）と
 * 同じ `clientIpOf` を通すので、画面に出る IP と実際に除外判定される IP がずれない。
 */
async function AccessLogIpSection({ context }: { context: PageContext }) {
  const [exclusions, headerStore] = await Promise.all([
    getAccessLogIpExclusions(context, {}),
    headers(),
  ]);

  return (
    <AccessLogIpSettings
      rules={[...exclusions.rules]}
      clientIp={normalizeClientIp(clientIpOf(headerStore))}
    />
  );
}

async function TimeZoneSection({ canManage }: { canManage: boolean }) {
  const setting = await analyticsTimeZoneSetting();

  return (
    <TimeZoneSettings
      current={setting.value}
      source={setting.source}
      groups={timeZoneOptions(new Date(), [setting.value])}
      canManage={canManage}
    />
  );
}

/** 洗い替えの `summary.completedThrough`（`YYYY-MM-DD`）。無ければ null。 */
function completedThroughOf(summary: Readonly<Record<string, unknown>>): string | null {
  const value = summary['completedThrough'];
  return typeof value === 'string' ? value : null;
}

/**
 * 定期実行の状況（029 設計 §7.2）。
 *
 * `booted` は `listJobStatuses` の戻り値に無いので、メモリだけを見る `schedulerSnapshot()` を
 * ここで直接読む（DB にも認可にも関わらない）。日時は運用タイムゾーンの文字列にして渡す。
 *
 * 洗い替え（`analytics.timezoneRebuild`）の行だけ、進捗の注記と再実行の導線を足す
 * （032 設計 §7.3.1）。**出す条件は「直近の実行が `ok` でないとき」。**
 * 記録が無い・`ok` では出さない。`running` でも出すのは、実行中に落ちたプロセスが
 * 残した行から永久に抜け出せなくなるのを避けるため。
 */
async function JobStatusSection({ context }: { context: PageContext }) {
  const timeZone = await resolveAnalyticsTimeZone();
  const at = (instant: Date | null): string | null =>
    instant === null ? null : formatDateTimeInTimeZone(instant, timeZone);

  const statuses = await listJobStatuses(context, {});
  const snapshot = schedulerSnapshot();

  const recentErrors = statuses
    .flatMap((status) =>
      status.recentErrors.map((run) => ({
        jobLabel: JOB_LABEL[status.name],
        startedAt: run.startedAt,
        error: run.error ?? '',
      })),
    )
    .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())
    .slice(0, RECENT_ERROR_DISPLAY_LIMIT)
    .map((entry) => ({
      jobLabel: entry.jobLabel,
      at: at(entry.startedAt) ?? '',
      error: entry.error,
    }));

  const data: JobStatusCardData = {
    booted: snapshot.booted,
    enabled: snapshot.enabled,
    jobs: statuses.map((status) => {
      const lastRunStatus = status.lastRun?.status ?? null;
      // 再実行の導線は洗い替えの行にだけ置く。**直近の実行が `ok` でないときだけ。**
      const isRebuild = status.name === 'analytics.timezoneRebuild';
      const canRetry = isRebuild && lastRunStatus !== null && lastRunStatus !== 'ok';
      const retryNote = canRetry ? REBUILD_RETRY_NOTE[lastRunStatus] : null;

      return {
        name: status.name,
        label: JOB_LABEL[status.name],
        intervalMinutes: status.intervalMinutes,
        lastRunAt: at(status.lastRun?.startedAt ?? null),
        lastRunStatus,
        lastSuccessAt: at(status.lastSuccess?.finishedAt ?? status.lastSuccess?.startedAt ?? null),
        nextRunAt: at(status.nextRunAt),
        canRetry,
        progressNote:
          isRebuild && lastRunStatus === 'running' && status.lastRun !== null
            ? rebuildProgressText(completedThroughOf(status.lastRun.summary))
            : null,
        retryNote,
      };
    }),
    recentErrors,
  };

  return <JobStatusCard data={data} />;
}

async function PermissionsTab({ context, roles }: { context: PageContext; roles: RoleList }) {
  // ロールの数だけ問い合わせない（N+1）。1クエリでまとめて引く。
  const grants = await listRoleGrants(context, {});

  return (
    <PermissionMatrix
      roles={roles.map((role) => ({
        id: role.id,
        name: role.name,
        displayName: role.displayName,
      }))}
      permissions={listPermissions().map((permission) => ({
        name: permission.name,
        displayName: permission.displayName,
      }))}
      grants={grants}
    />
  );
}
