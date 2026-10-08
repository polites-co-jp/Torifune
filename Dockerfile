# Torifune のコンテナイメージ。
#
# Plugin の導入時にコンテナ内で再ビルドするため、standalone 出力ではなく
# ビルドツールチェーンを含んだイメージにしている（D-02 / R-01）。
#
# /app/plugins は Volume で、Docker がイメージの中身を写すのは Volume を初めて作ったときだけ。
# そこで同梱 Plugin の写しを Volume の外（/app/.torifune-bundled-plugins）に残し、
# entrypoint.sh が起動の最初に Volume へ反映する（同梱 Plugin だけ。利用者の Plugin には触れない）。
# 焼いたビルドがどのソースから作られたかを指紋として .next の中に書き、entrypoint.sh が
# 起動時に Volume の指紋と突き合わせる（食い違えば起動の前に 1 回だけ再ビルドする）。
# 詳細: docs/設計/050-bundled-plugin-sync/設計.md §6.1・§6.7
FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    # Plugin の置き場を明示する。既定でも解決できるが、ここを
    # VOLUME で差し替える構成があるため、意図を設定として残す。
    TORIFUNE_PLUGINS_DIR=/app/plugins \
    # 同梱 Plugin の写し（Volume の外）。entrypoint.sh の同期がここを正として読む。
    TORIFUNE_BUNDLED_PLUGINS_DIR=/app/.torifune-bundled-plugins \
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

# 同梱 Plugin の写しを Volume の外へ残し、焼いたビルドの指紋を .next の中へ書く。
# 写しもビルドも同じ /app/plugins から作るので、両者は同じソースから出来ている。
# 指紋を書けなければイメージのビルドを落とす（指紋の無いイメージは、起動のたびに再ビルドする）。
RUN cp -a /app/plugins /app/.torifune-bundled-plugins \
 && node packages/cli/dist/main.js plugins fingerprint --plugins-dir=/app/plugins > apps/web/.next/torifune-plugin-sources

# plugins/ とビルド出力だけが書き込み可能であればよい。
VOLUME ["/app/plugins"]

EXPOSE 3000

ENTRYPOINT ["/app/docker/entrypoint.sh"]
