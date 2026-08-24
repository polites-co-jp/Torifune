import { z } from 'zod';
import type { PluginOperation } from '@/plugin/operations';
import type { PluginSummary } from '@/application/plugin/plugin-use-cases';

/**
 * Plugin 管理 API の Zod スキーマ（012-plugin-manager 設計 §9）。
 *
 * ここが OpenAPI の入力にもなる（`api/openapi.ts`）。
 */

export const installPluginSchema = z.object({
  pluginId: z.string().min(1, '入力してください。'),
  /** 要求 Permission を見たうえでの同意。 */
  acknowledgedPermissions: z.boolean().refine((value) => value, {
    message: '要求している権限への同意が必要です。',
  }),
  csrfToken: z.string().optional(),
});

export const uninstallPluginSchema = z.object({
  /** Plugin が保存したデータも消すか。**既定で消さない。** */
  deleteData: z.boolean().default(false),
  /** ファイルごと消すか。false なら「検出済み・未導入」へ戻る。 */
  deleteFiles: z.boolean().default(true),
  /** 押し間違いを防ぐ確認。Plugin ID と一致させる。 */
  confirm: z.string().min(1, '入力してください。'),
  csrfToken: z.string().optional(),
});

export const togglePluginSchema = z.object({
  csrfToken: z.string().optional(),
});

export interface PluginResponse {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly status: string | null;
  readonly loaded: boolean;
  readonly permissions: readonly string[];
  readonly dependencies: Readonly<Record<string, string>>;
  readonly description: string | null;
}

export function toPluginResponse(summary: PluginSummary): PluginResponse {
  return {
    id: summary.id,
    name: summary.name,
    version: summary.version,
    status: summary.status,
    loaded: summary.loaded,
    permissions: summary.permissions,
    dependencies: summary.dependencies,
    description: summary.description,
  };
}

export interface PluginOperationResponse {
  readonly id: string;
  readonly pluginId: string;
  readonly kind: string;
  readonly status: string;
  readonly message: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export function toOperationResponse(operation: PluginOperation): PluginOperationResponse {
  return {
    id: operation.id,
    pluginId: operation.pluginId,
    kind: operation.kind,
    status: operation.status,
    message: operation.message,
    startedAt: operation.startedAt.toISOString(),
    finishedAt: operation.finishedAt?.toISOString() ?? null,
  };
}
