# Torifune のコンテナイメージ。
#
# Plugin の導入時にコンテナ内で再ビルドするため、standalone 出力ではなく
# ビルドツールチェーンを含んだイメージにしている（D-02 / R-01）。
FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    # Plugin の置き場を明示する。既定でも解決できるが、ここを
    # VOLUME で差し替える構成があるため、意図を設定として残す。
    TORIFUNE_PLUGINS_DIR=/app/plugins \
    # 監視ループはこの entrypoint にある。無い環境で落ちると誰も起こしてくれない。
    TORIFUNE_SELF_RESTART=1

RUN corepack enable

WORKDIR /app

# 依存の解決だけを先に行い、ソース変更でキャッシュが落ちないようにする。
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/plugin-api/package.json packages/plugin-api/
COPY packages/cli/package.json packages/cli/
# 再ビルドできる必要があるため devDependencies も入れる。
RUN pnpm install --frozen-lockfile --prod=false

COPY . .

# ENTRYPOINT はこのスクリプトを直接 exec するため、実行ビットが要る。
# Git 側にも 100755 で記録してあるが、実行ビットを保てない環境
# （Windows の core.filemode=false、zip でのソース取得）から作っても
# 動くイメージになるよう、ここでも立てる。
RUN chmod +x docker/entrypoint.sh

# Plugin レジストリ（apps/web/src/plugin/generated-registry.ts）を先に作る。
# Next.js は静的な import しか辿れないため、plugins/ を走査した生成物が web の
# ビルドより前に無いと Module not found で落ちる。
# ここを `pnpm build`（generate:plugins を含む）ではなく --filter で組み立てている
# ため、生成をこのステップで明示する。.dockerignore がホスト側の生成物を除外して
# いるので、イメージの中身は必ずこのビルドで作り直したものになる。
RUN pnpm generate:plugins \
 && pnpm --filter @torifune/cli build \
 && pnpm --filter @torifune/web build

# plugins/ とビルド出力だけが書き込み可能であればよい。
VOLUME ["/app/plugins"]

EXPOSE 3000

ENTRYPOINT ["/app/docker/entrypoint.sh"]
