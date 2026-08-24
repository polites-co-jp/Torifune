import { buildOpenApiDocument } from '@/api/openapi';
import '@/api/endpoints';

/**
 * API 仕様（05_API設計.md §40）。
 *
 * **認証を要求しない。** API の形は秘密ではなく、隠しても攻撃者には効かない。
 * むしろ利用者の役に立つ。内部エンドポイントは文書に含めない。
 */
export function GET(): Response {
  return Response.json(buildOpenApiDocument(), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
