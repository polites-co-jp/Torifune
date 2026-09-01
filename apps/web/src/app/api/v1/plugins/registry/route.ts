import { z } from 'zod';
import { installFromRegistry, listRegistryPlugins } from '@/application/plugin/plugin-use-cases';
import { dataResponse } from '@/api/response';
import { defineRoute } from '@/api/route';

/**
 * Plugin Registry（03_プラグイン設計.md §14.1 §15）。
 *
 * Registry は「HTTPS で取れる JSON」と定義している（020-plugin-registry 設計 §2.1）。
 * 中央のサービスを作らない。
 */

export const GET = defineRoute({
  operationId: 'listRegistryPlugins',
  method: 'GET',
  path: '/plugins/registry',
  summary: 'Registry の Plugin 一覧を取得する',
  permission: 'plugin.manage',
  query: z.object({ q: z.string().max(200).optional() }),
  // 外部への取得を伴う。連打で配布元を叩かせない。
  rateLimit: { windowMs: 60_000, max: 30 },
  handler: async ({ context, query }) =>
    dataResponse(await listRegistryPlugins(context, { keyword: query.q ?? '' })),
});

export const POST = defineRoute({
  operationId: 'installFromRegistry',
  method: 'POST',
  path: '/plugins/registry',
  summary: 'Registry から Plugin を導入する',
  permission: 'plugin.manage',
  body: z.object({
    pluginId: z.string().min(1).max(200),
    csrfToken: z.string().optional(),
  }),
  // 導入は再ビルドを伴う重い操作。連打させない。
  rateLimit: { windowMs: 60_000, max: 5 },
  handler: async ({ context, body }) =>
    dataResponse(await installFromRegistry(context, { pluginId: body.pluginId })),
});
