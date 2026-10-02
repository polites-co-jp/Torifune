#!/usr/bin/env bash
# Plugin の再ビルドと失敗時の復帰を、**本番と同じイメージで**確かめる。
#
# 検証するのは `012-plugin-manager` の受け入れ条件 #30-#33 と、
# `052-rebuild-without-tests` の受け入れ条件 #16・#17（出力では `052 #16` のように見分ける）。
#
#   #30 ビルドに失敗しても、再起動後に直前の正常な状態で立ち上がる
#   #31 失敗した操作が failed として残る
#   #32 失敗した Plugin が隔離され、次の再ビルドを壊さない
#   #33 隔離された Plugin のファイルは消えていない
#   052 #16 同梱 Plugin のフォルダが無くても、次の再ビルドが通る
#           （本番のビルドはテストファイルを型検査しない）
#   052 #17 同梱 Plugin のコードの型の誤りは、イメージの中でも今までどおりビルドを止める
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

# ログの `mark` 行より後に、再ビルドの結果（成功か失敗か）が現れるまで待つ。
# **失敗なら待ち切らずに直ちに落とす**（`wait_for_log` は失敗でも 15 分待ち切るまで落ちない）。
# 失敗のときは、`mark` より後の型の誤り（`error TS`）の行を出す。
wait_for_rebuild_result_since() {
  local mark="$1" label="$2" since
  for _ in $(seq 1 180); do
    since="$(docker logs "$APP" 2>&1 | tail -n "+$((mark + 1))")"
    if grep -q -- 'rebuild FAILED' <<<"$since"; then
      grep -- 'error TS' <<<"$since" >&2 || true
      die "$label 再ビルドが失敗した（rebuild FAILED）"
    fi
    if grep -q -- 'rebuild succeeded' <<<"$since"; then
      return 0
    fi
    sleep 5
  done
  docker logs "$APP" || true
  die "$label ログに再ビルドの結果が現れなかった"
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

# --- 052 #16（前半）--------------------------------------------------------
# #32 の導入の前に、同梱 Plugin（sns-threads）をこのコンテナの /app/plugins から消す。
# テストファイルがこの Plugin のソースを直接 import しているので、ビルドがテストまで
# 型検査すると、次の再ビルドが TS2307 で落ちる（052 設計 §1.2 の 7）。
# 削除の直前のログの行数を控え、それより後のログだけを見る。
MARK="$(docker logs "$APP" 2>&1 | wc -l | tr -d ' ')"
in_app rm -rf /app/plugins/sns-threads
in_app test ! -e /app/plugins/sns-threads || die "052 #16 sns-threads を消せていない"
log "052 #16 同梱 Plugin（sns-threads）を消した。この状態で次の再ビルドを走らせる"

in_app node /tmp/driver.mjs install-example
wait_for_rebuild_result_since "$MARK" '052 #16'
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

# --- 052 #16（後半）--------------------------------------------------------
SINCE_MARK="$(docker logs "$APP" 2>&1 | tail -n "+$((MARK + 1))")"
if grep -q -- 'error TS2307' <<<"$SINCE_MARK"; then
  die "052 #16 同梱 Plugin を消した後のログに error TS2307 がある"
fi
in_app test -f /app/apps/web/src/plugin/generated-registry.ts \
  || die "052 #16 コンテナにレジストリ（generated-registry.ts）が無い"
if in_app grep -q 'plugins/sns-threads/' /app/apps/web/src/plugin/generated-registry.ts; then
  die "052 #16 消した同梱 Plugin（sns-threads）がレジストリに残っている"
fi
log "OK 052 #16 同梱 Plugin のフォルダが無くても、次の再ビルドは通った"

# --- 052 #17 ---------------------------------------------------------------
# 同じイメージで、同梱 Plugin のエントリの末尾に型の誤りを足して `pnpm build`
# （entrypoint の再ビルドと同じコマンド）を走らせる。アプリもデータベースも使わない。
# 失敗しなければ、Plugin のコードの型検査がビルドから外れている。
log "052 #17 同梱 Plugin のコードに型の誤りを足すと、ビルドが止まることを確かめる"
GUARD_CMD="$(
  cat <<'SH'
set -e
echo "" >> /app/plugins/sns-x-manual/index.ts
echo "export const __guard052: number = 'x';" >> /app/plugins/sns-x-manual/index.ts
cd /app
pnpm build
SH
)"
if OUT="$(docker run --rm --entrypoint sh "$IMAGE" -c "$GUARD_CMD" 2>&1)"; then
  echo "$OUT" | tail -n 40 >&2
  die "052 #17 同梱 Plugin のコードに型の誤りがあるのに pnpm build が成功した"
fi
if ! grep -q -- 'plugins/sns-x-manual/index.ts' <<<"$OUT" || ! grep -q -- 'error TS2322' <<<"$OUT"; then
  echo "$OUT" | tail -n 40 >&2
  die "052 #17 ビルドの失敗の出力に plugins/sns-x-manual/index.ts と error TS2322 が無い"
fi
log "OK 052 #17 同梱 Plugin のコードの型の誤りは、今までどおりビルドを止めた"

log "すべて成功した（#30-#33・052 #16-#17）"
