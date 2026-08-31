#!/usr/bin/env bash
# Plugin の再ビルドと失敗時の復帰を、**本番と同じイメージで**確かめる。
#
# 検証するのは `012-plugin-manager` の受け入れ条件 #30-#33。
#
#   #30 ビルドに失敗しても、再起動後に直前の正常な状態で立ち上がる
#   #31 失敗した操作が failed として残る
#   #32 失敗した Plugin が隔離され、次の再ビルドを壊さない
#   #33 隔離された Plugin のファイルは消えていない
#
# **`pnpm test` / `pnpm test:e2e` では検出できない領域を見る。**
# dev と Vitest では動くのに本番ビルドでだけ壊れる不具合が実際に出た
# （`import.meta.dirname` が Next.js のサーバーバンドルで undefined になる）。
#
# ホストへポートを公開しない。API は docker exec でコンテナの中から叩く。
set -euo pipefail

IMAGE="${TORIFUNE_VERIFY_IMAGE:-torifune-verify:latest}"
NETWORK="${TORIFUNE_VERIFY_NETWORK:-torifune-verify}"
DB="${NETWORK}-db"
APP="${NETWORK}-app"
KEY='dGVzdC1vbmx5LWtleS1kby1ub3QtdXNlLWluLXByb2Q='
DB_URL="postgresql://torifune:torifune@${DB}:5432/torifune"
# コンテナ側の絶対パスをホストのパスへ書き換えられないようにする。
# Git Bash（MSYS）だけの挙動で、Linux では単に無視される。
# ホスト側は相対パスで渡すので、この設定と衝突しない。
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."

log() { echo "[verify] $*"; }
die() { echo "[verify] NG: $*" >&2; exit 1; }

cleanup() {
  docker rm -f "$APP" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT

in_app() { docker exec "$APP" "$@"; }

wait_for_app() {
  for _ in $(seq 1 120); do
    if in_app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  docker logs "$APP" || true
  die "アプリが応答しない"
}

# ログの最後のマーカーを待つ。再ビルドは数分かかる。
wait_for_log() {
  local marker="$1"
  for _ in $(seq 1 180); do
    if docker logs "$APP" 2>&1 | grep -q -- "$marker"; then
      return 0
    fi
    sleep 5
  done
  docker logs "$APP" || true
  die "ログに '$marker' が現れなかった"
}

build_id() { in_app cat /app/apps/web/.next/BUILD_ID; }

cleanup
log "イメージをビルドする"
docker build -t "$IMAGE" .

log "ネットワークとデータベースを用意する"
docker network create "$NETWORK" >/dev/null
docker run -d --name "$DB" --network "$NETWORK" \
  -e POSTGRES_USER=torifune -e POSTGRES_PASSWORD=torifune -e POSTGRES_DB=torifune \
  -e POSTGRES_INITDB_ARGS='--encoding=UTF8 --locale=C' \
  --health-cmd='pg_isready -U torifune -d torifune' --health-interval=3s --health-retries=20 \
  postgres:17-alpine >/dev/null

for _ in $(seq 1 40); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$DB")" = healthy ] && break
  sleep 2
done
[ "$(docker inspect -f '{{.State.Health.Status}}' "$DB")" = healthy ] || die "データベースが healthy にならない"

# 空のデータベースへ全スキーマを適用できること（README §1 の6項目め）。
log "マイグレーションを適用する"
docker run --rm --network "$NETWORK" --entrypoint node "$IMAGE" \
  /app/packages/cli/dist/main.js migrate "--database-url=$DB_URL"

# イメージが Plugin の置き場を宣言していること。
# 宣言が消えても下の起動（空で上書き）は通ってしまうため、ここで別に見る。
docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE" \
  | grep -q '^TORIFUNE_PLUGINS_DIR=/app/plugins$' \
  || die "イメージが TORIFUNE_PLUGINS_DIR を宣言していない"

log "アプリを起動する"
# **TORIFUNE_PLUGINS_DIR を空にして起動する。**
# 空は未設定として扱われるので、既定の解決（cwd から遡る経路）を通る。
# ここを環境変数で固定してしまうと、本番ビルドで `import.meta.dirname` が
# undefined になって壊れる不具合（R-09）を、この検証では見つけられない。
docker run -d --name "$APP" --network "$NETWORK" \
  -e "DATABASE_URL=$DB_URL" -e "TORIFUNE_ENCRYPTION_KEY=$KEY" \
  -e TORIFUNE_PLUGINS_DIR= "$IMAGE" >/dev/null
wait_for_app

docker cp scripts/container-verify/driver.mjs "$APP:/tmp/driver.mjs"
in_app node /tmp/driver.mjs setup

BEFORE="$(build_id)"
log "導入前の BUILD_ID: $BEFORE"

log "ビルドを壊す Plugin を導入する"
in_app node /tmp/driver.mjs install-broken

wait_for_log 'rebuild FAILED'
wait_for_app

# --- #30 -------------------------------------------------------------------
AFTER="$(build_id)"
[ "$AFTER" = "$BEFORE" ] || die "#30 ロールバックしていない（BUILD_ID が $BEFORE から $AFTER へ変わった）"
in_app node -e "
for (const path of ['/api/health', '/api/ready', '/login']) {
  const r = await fetch('http://127.0.0.1:3000' + path);
  if (r.status !== 200) { console.error(path, r.status); process.exit(1); }
}" || die "#30 直前のビルドで画面を返せていない"
log "OK #30 直前の正常なビルドのまま立ち上がった"

# --- #31 / #33 -------------------------------------------------------------
STATE="$(in_app node /tmp/driver.mjs state)"
echo "$STATE" | grep -q '"pluginId":"broken-plugin","kind":"install","status":"failed"' \
  || die "#31 失敗した操作が failed になっていない: $STATE"
log "OK #31 失敗した操作が failed として残った"

in_app test -f /app/plugins/broken-plugin/.torifune-quarantine || die "#32 隔離マークが無い"
in_app test -f /app/plugins/broken-plugin/plugin.json || die "#33 Plugin のファイルが消えている"
in_app test -f /app/plugins/broken-plugin/index.tsx || die "#33 Plugin のファイルが消えている"
log "OK #33 隔離された Plugin のファイルは残っている"

# --- #32 -------------------------------------------------------------------
log "隔離のあと、次の再ビルドが通ることを確かめる"
in_app node /tmp/driver.mjs install-example
wait_for_log 'rebuild succeeded'
wait_for_app

FINAL="$(build_id)"
[ "$FINAL" != "$BEFORE" ] || die "#32 再ビルドされていない（BUILD_ID が $BEFORE のまま）"
docker logs "$APP" 2>&1 | grep -q 'broken-plugin: 隔離されているため読み込まない' \
  || die "#32 隔離された Plugin が読み込まれている"
log "OK #32 隔離され、次の再ビルドは成功した（BUILD_ID: $BEFORE → $FINAL）"

FINAL_STATE="$(in_app node /tmp/driver.mjs state)"
echo "$FINAL_STATE" | grep -q '"pluginId":"example-plugin","kind":"install","status":"succeeded"' \
  || die "サンプル Plugin の導入が succeeded になっていない: $FINAL_STATE"

log "すべて成功した（#30-#33）"
