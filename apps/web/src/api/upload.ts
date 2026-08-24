import { errorResponse } from './errors';

/**
 * ファイルのアップロードの受け取り。
 *
 * **フォームは1度だけ読む。** clone して2度読むと、大きなファイルで
 * その分だけ余計に確保する。
 */

/** 上限。ここで足切りしないと、読み切ってから弾くことになる。 */
export function maxUploadBytes(): number {
  return Number(process.env['TORIFUNE_PLUGIN_MAX_BYTES'] ?? 32 * 1024 * 1024);
}

export interface UploadedPackage {
  readonly archive: Buffer;
  /** 同意した Plugin ID。inspect の段階では入っていない。 */
  readonly pluginId: string | null;
}

export async function readUploadedPackage(request: Request): Promise<UploadedPackage | Response> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > maxUploadBytes()) {
    return errorResponse('VALIDATION_ERROR', {
      file: [`ファイルが大きすぎます（上限 ${maxUploadBytes()} バイト）。`],
    });
  }

  const form = await request.formData().catch(() => null);
  if (form === null) {
    return errorResponse('VALIDATION_ERROR', { file: ['ファイルを読み取れませんでした。'] });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return errorResponse('VALIDATION_ERROR', { file: ['ファイルを選択してください。'] });
  }

  if (file.size > maxUploadBytes()) {
    return errorResponse('VALIDATION_ERROR', {
      file: [`ファイルが大きすぎます（上限 ${maxUploadBytes()} バイト）。`],
    });
  }

  const pluginId = form.get('pluginId');

  return {
    archive: Buffer.from(await file.arrayBuffer()),
    pluginId: typeof pluginId === 'string' && pluginId !== '' ? pluginId : null,
  };
}
