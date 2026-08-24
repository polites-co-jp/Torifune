import { writeFile } from 'node:fs/promises';

/**
 * 再ビルドの要求（決定事項 D-02、012-plugin-manager 設計 §7）。
 *
 * Plugin の読み込みはビルド時に固定されるため、導入・削除は再ビルドを伴う。
 * アプリは sentinel を書いて**終了コード 75 で落ちる**。
 * `docker/entrypoint.sh` がそれを受けて、レジストリを再生成し、
 * ビルドし直して起動する。
 *
 * **アプリはレジストリを生成しない。** 生成の実体は
 * `scripts/generate-plugin-registry.mjs` ひとつに保つ。2箇所にあると必ずずれる。
 */

export const REBUILD_EXIT_CODE = 75;

/** 監視ループのある環境か。無い環境で落ちると、誰も起こしてくれない。 */
export function canSelfRestart(): boolean {
  return process.env['TORIFUNE_SELF_RESTART'] === '1';
}

function sentinelPath(): string {
  return process.env['TORIFUNE_REBUILD_SENTINEL'] ?? '/app/.torifune-rebuild-request';
}

export interface RebuildRequest {
  /** 実際に落ちるか。開発環境では落ちない。 */
  readonly willRestart: boolean;
  /** 画面に出す案内。 */
  readonly message: string;
}

/**
 * 再ビルドを要求する。
 *
 * 落ちるのは呼び出し元が応答を返し終えたあと。ここでは予約するだけにする。
 * 応答を返す前に落とすと、要求した側は何が起きたか分からない。
 */
export async function requestRebuild(): Promise<RebuildRequest> {
  if (!canSelfRestart()) {
    return {
      willRestart: false,
      message:
        '再ビルドが必要です。開発環境では自動で再起動しません。`pnpm dev` を再起動してください。',
    };
  }

  await writeFile(sentinelPath(), `${new Date().toISOString()}\n`, 'utf8');

  return {
    willRestart: true,
    message: '再ビルドして再起動します。数分ほど利用できません。',
  };
}

/** 応答を返し終えてから落とす。 */
export function scheduleRestart(delayMs = 500): void {
  if (!canSelfRestart()) {
    return;
  }

  const timer = setTimeout(() => {
    process.exit(REBUILD_EXIT_CODE);
  }, delayMs);

  // 再起動のためだけにプロセスを生かし続けない。
  timer.unref?.();
}
