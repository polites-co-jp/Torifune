# Torifune のコンテナイメージ。
#
# Plugin の導入時にコンテナ内で再ビルドするため、standalone 出力ではなく
# ビルドツールチェーンを含んだイメージにしている（D-02 / R-01）。
FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

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

RUN pnpm --filter @torifune/cli build \
 && pnpm --filter @torifune/web build

# plugins/ とビルド出力だけが書き込み可能であればよい。
VOLUME ["/app/plugins"]

EXPOSE 3000

ENTRYPOINT ["/app/docker/entrypoint.sh"]
