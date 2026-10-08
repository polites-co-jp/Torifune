#!/usr/bin/env bash
# 同梱 Plugin の起動時の反映と、起動時の突き合わせを、**本番と同じイメージで**確かめる。
#
# 検証するのは `050-bundled-plugin-sync` の受け入れ条件 #43-#49
# （設計: docs/設計/050-bundled-plugin-sync/設計.md §10.6）。
#
#   #43 イメージが同梱の写しの場所を宣言し、写し・/app/plugins の指紋と焼いたビルドの指紋が等しい
#   #44 新しい名前付き Volume で起動すると、同梱 Plugin に印が付き（adopted）、起動前の再ビルドは無い
#   #45 その起動の BUILD_ID は焼き込まれた BUILD_ID のまま
#   #46 古い Volume の再現（印の無い古い写し・利用者の編集・消えたフォルダ・利用者の Plugin）→ 作り直し
#   #47 古い写しは置き換わり（退避つき）、利用者の編集は残り、消えたフォルダは戻る。手順書が読める
#   #48 利用者の Plugin は触られず、起動前の再ビルドでビルドに入り、有効なまま読み込まれる
#   #49 その後の再ビルドも更新済みのソースから作られ、ビルドの指紋が Volume と揃う
#
# **Volume を名前付きで付ける**（運用と同じ）。`verify-container-rebuild.sh` は Volume を付けずに起動するので、
# 「Volume が古いまま残る」不具合はあちらでは見えない。
#
# ホストへポートを公開しない。API は docker exec でコンテナの中から叩く。
# イメージをビルドするので、`verify-container-rebuild.sh` や `pnpm test` と同時に流さない。
set -euo pipefail

IMAGE="${TORIFUNE_VERIFY_BUNDLED_IMAGE:-torifune-verify-bundled:latest}"
NETWORK="${TORIFUNE_VERIFY_BUNDLED_NETWORK:-torifune-verify-bundled}"
DB="${NETWORK}-db"
APP="${NETWORK}-app"
VOLUME="${NETWORK}-plugins"
KEY='dGVzdC1vbmx5LWtleS1kby1ub3QtdXNlLWluLXByb2Q='
DB_URL="postgresql://torifune:torifune@${DB}:5432/torifune"
BUNDLED_DIR='/app/.torifune-bundled-plugins'
CLI='node /app/packages/cli/dist/main.js'
USER_PLUGIN='verify-user-plugin'
# コンテナ側の絶対パスをホストのパスへ書き換えられないようにする。
# Git Bash（MSYS）だけの挙動で、Linux では単に無視される。
export MSYS_NO_PATHCONV=1

cd "$(dirname "$0")/.."

log() { echo "[verify] $*"; }
die() { echo "[verify] NG: $*" >&2; exit 1; }

cleanup() {
  docker rm -f "$APP" "$DB" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

in_app() { docker exec "$APP" "$@"; }
app_logs() { docker logs "$APP" 2>&1; }

start_app() {
  docker run -d --name "$APP" --network "$NETWORK" \
    -v "$VOLUME:/app/plugins" \
    -e "DATABASE_URL=$DB_URL" -e "TORIFUNE_ENCRYPTION_KEY=$KEY" \
    "$IMAGE" >/dev/null
}

# 既定は 4 分。起動前の再ビルドを挟む起動は長く待つ（引数で回数を渡す。1 回 2 秒）。
wait_for_app() {
  local tries="${1:-120}"
  for _ in $(seq 1 "$tries"); do
    if in_app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  app_logs || true
  die "アプリが応答しない"
}

# ログに印が n 回以上現れるまで待つ（再ビルドは数分かかる）。
# 既存の wait_for_log は「一度でも現れれば返る」ので、2 回目の再ビルドを待てない（実装プラン §7 の 4）。
# 待っている間に再ビルドの失敗が増えたら、待ち切らずに落とす。
wait_for_log_count() {
  local marker="$1" want="$2" failed_before
  failed_before="$(app_logs | grep -c -- 'rebuild FAILED' || true)"
  for _ in $(seq 1 180); do
    if [ "$(app_logs | grep -c -- "$marker" || true)" -ge "$want" ]; then
      return 0
    fi
    if [ "$(app_logs | grep -c -- 'rebuild FAILED' || true)" -gt "$failed_before" ]; then
      app_logs || true
      die "'$marker' を待つ間に再ビルドが失敗した"
    fi
    sleep 5
  done
  app_logs || true
  die "ログに '$marker' が $want 回現れなかった"
}

# ログを変数に取ってから探す（pipefail の下で grep -q が先に閉じると、docker logs が SIGPIPE で落ちて
# 「見つからない」と取り違えるため）。
log_has() {
  local logs
  logs="$(app_logs)"
  grep -qF -- "$1" <<<"$logs"
}

build_id() { in_app cat /app/apps/web/.next/BUILD_ID; }

# 印が中身と一致しているか（driver が設計 §6.2.1 の木のハッシュを本体とは別に計算する）。
expect_markers_match() {
  local label="$1"
  shift
  local json
  json="$(in_app node /tmp/driver.mjs markers "$@")"
  in_app node -e '
    const rows = JSON.parse(process.argv[1]);
    const bad = rows.filter((r) => !r.exists || r.marker === null || r.marker !== r.tree);
    if (bad.length > 0) { console.error(JSON.stringify(bad)); process.exit(1); }
  ' "$json" || die "$label 印が無い、または中身と一致しない: $json"
}

# driver をコンテナへ置き、管理者のセッションを作る（setup：最初の管理者を作る / login：ログインし直す）。
prepare_driver() {
  docker cp scripts/container-verify/driver.mjs "$APP:/tmp/driver.mjs"
  in_app node /tmp/driver.mjs "$1"
}

cleanup
log "イメージをビルドする"
docker build -t "$IMAGE" .

# --- #43 -------------------------------------------------------------------
IMAGE_ENV="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$IMAGE")"
grep -q "^TORIFUNE_BUNDLED_PLUGINS_DIR=${BUNDLED_DIR}\$" <<<"$IMAGE_ENV" \
  || die "#43 イメージが TORIFUNE_BUNDLED_PLUGINS_DIR=${BUNDLED_DIR} を宣言していない"

# --entrypoint を差し替えて起動する（同期も再ビルドも走らない、イメージそのままの状態）。
# 匿名 Volume にはイメージの /app/plugins が写り、--rm で消える。
FINGERPRINTS="$(docker run --rm --entrypoint sh "$IMAGE" -c "
  set -e
  $CLI plugins fingerprint --plugins-dir=$BUNDLED_DIR
  $CLI plugins fingerprint --plugins-dir=/app/plugins
  cat /app/apps/web/.next/torifune-plugin-sources
")" || die "#43 指紋を読めない: $FINGERPRINTS"
FP_BUNDLED="$(sed -n 1p <<<"$FINGERPRINTS")"
FP_PLUGINS="$(sed -n 2p <<<"$FINGERPRINTS")"
FP_BAKED="$(sed -n 3p <<<"$FINGERPRINTS")"
grep -qE '^sha256:[0-9a-f]{64}$' <<<"$FP_BUNDLED" || die "#43 指紋の形が違う: $FP_BUNDLED"
[ "$FP_BUNDLED" = "$FP_PLUGINS" ] || die "#43 写しと /app/plugins の指紋が違う: $FP_BUNDLED / $FP_PLUGINS"
[ "$FP_BUNDLED" = "$FP_BAKED" ] || die "#43 写しと焼いたビルドの指紋が違う: $FP_BUNDLED / $FP_BAKED"
log "OK #43 写し・/app/plugins・焼いたビルドの指紋が等しい（$FP_BAKED）"

# 同梱 Plugin の ID（写しのトップレベルの、. で始まらないディレクトリ。設計 §6.1）。
BUNDLED_IDS="$(docker run --rm --entrypoint sh "$IMAGE" -c \
  "find $BUNDLED_DIR -mindepth 1 -maxdepth 1 -type d ! -name '.*' -exec basename {} \; | sort")"
[ -n "$BUNDLED_IDS" ] || die "同梱 Plugin が 1 つも無い"
mapfile -t BUNDLED <<<"$BUNDLED_IDS"
for id in sns-bluesky sns-x-manual sns-threads; do
  grep -qx -- "$id" <<<"$BUNDLED_IDS" || die "検証の前提の同梱 Plugin $id が写しに無い"
done
log "同梱 Plugin: ${BUNDLED[*]}"

BAKED_BUILD_ID="$(docker run --rm --entrypoint cat "$IMAGE" /app/apps/web/.next/BUILD_ID)"

log "ネットワークとデータベースを用意する"
docker network create "$NETWORK" >/dev/null
docker volume create "$VOLUME" >/dev/null
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

log "マイグレーションを適用する"
docker run --rm --network "$NETWORK" --entrypoint node "$IMAGE" \
  /app/packages/cli/dist/main.js migrate "--database-url=$DB_URL"

# --- #44 / #45 -------------------------------------------------------------
log "新しい名前付き Volume でアプリを起動する"
start_app
wait_for_app
prepare_driver setup

for id in "${BUNDLED[@]}"; do
  log_has "[torifune] bundled plugins: $id adopted" || die "#44 $id が adopted になっていない"
done
FIRST_LOGS="$(app_logs)"
SUMMARY="$(grep -F '[torifune] bundled plugins: summary' <<<"$FIRST_LOGS" || true)"
[ -n "$SUMMARY" ] || die "#44 同期の要約の行が無い"
grep -q 'failed=0' <<<"$SUMMARY" || die "#44 同期の要約が failed=0 でない: $SUMMARY"
if grep -q 'rebuilding' <<<"$FIRST_LOGS"; then
  echo "$FIRST_LOGS"
  die "#44 新しい Volume の起動で再ビルドが走った"
fi
expect_markers_match "#44" "${BUNDLED[@]}"
log "OK #44 同梱 Plugin に印が付き（adopted）、再ビルドは走らなかった"

FIRST_BUILD_ID="$(build_id)"
[ "$FIRST_BUILD_ID" = "$BAKED_BUILD_ID" ] \
  || die "#45 BUILD_ID が焼き込まれたものと違う（$BAKED_BUILD_ID → $FIRST_BUILD_ID）"
log "OK #45 焼き込まれたビルドのまま起動した（BUILD_ID: $FIRST_BUILD_ID）"

# --- #46 -------------------------------------------------------------------
log "#46 古い Volume を再現する"
# sns-bluesky：050 より前の、手順書が無かった頃の写し（印なし・help/ なし・help の宣言なし）。
in_app rm -f /app/plugins/sns-bluesky/.torifune-bundled
in_app rm -rf /app/plugins/sns-bluesky/help
in_app node -e "
const fs = require('node:fs');
const path = '/app/plugins/sns-bluesky/plugin.json';
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
delete manifest.help;
fs.writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
"
# sns-x-manual：同期の後に利用者が編集した（印は残す）。
USER_EDIT='<!-- verify-bundled-plugin-sync: user edit -->'
in_app sh -c "printf '%s\n' '$USER_EDIT' >> /app/plugins/sns-x-manual/README.md"

# 利用者の Plugin の導入（監視ループの再ビルド）は、sns-threads を消す**前に**済ませる。
# web のビルドは apps/web のテストも型検査し、そのテストが同梱 Plugin のソースを import するので、
# 同梱 Plugin のフォルダが無いと監視ループの再ビルドが失敗する（監視ループの再ビルドは同期しない。
# 設計 §6.5・§6.7.3）。#46 の意図（作り直す時点で同梱のフォルダが無い）は、消すのを作り直しの直前に
# 移しても変わらない（実装プラン §8 の 30）。
log "#46 利用者の Plugin を Package で導入する"
in_app node /tmp/driver.mjs install-user
wait_for_log_count 'rebuild succeeded' 1
wait_for_app
in_app node /tmp/driver.mjs enable "$USER_PLUGIN"
STATE="$(in_app node /tmp/driver.mjs plugin "$USER_PLUGIN")"
grep -q '"status":"enabled"' <<<"$STATE" || die "#46 利用者の Plugin が有効にならない: $STATE"

user_plugin_files() {
  in_app sh -c "cd /app/plugins/$USER_PLUGIN && find . -type f -exec sha256sum {} + | sort"
}
USER_FILES_BEFORE="$(user_plugin_files)"
[ -n "$USER_FILES_BEFORE" ] || die "#46 利用者の Plugin のファイルが無い"

# sns-threads：フォルダごと消えた（作り直しの直前。上の注を参照）。
in_app rm -rf /app/plugins/sns-threads

log "#46 コンテナを作り直す（同じイメージ・同じ Volume）"
docker rm -f "$APP" >/dev/null
start_app
# 利用者の Plugin があるので、起動前に 1 回再ビルドする（設計 §6.7.3）。再ビルドの間はアプリが応答しない。
wait_for_app 450
if log_has 'rebuild FAILED'; then
  app_logs || true
  die "#48 作り直しの後の起動前の再ビルドが失敗した"
fi
log_has 'rebuild succeeded' || die "#48 作り直しの後、起動前の再ビルドが走っていない"
prepare_driver login

# --- #47 -------------------------------------------------------------------
log_has '[torifune] bundled plugins: sns-bluesky updated: legacy' \
  || die "#47 sns-bluesky が updated: legacy になっていない"
log_has '[torifune] bundled plugins: sns-x-manual skipped: modified' \
  || die "#47 sns-x-manual が skipped: modified になっていない"
log_has '[torifune] bundled plugins: sns-threads restored' \
  || die "#47 sns-threads が restored になっていない"
in_app test -f /app/plugins/sns-bluesky/help/credentials.md || die "#47 sns-bluesky の手順書のファイルが無い"
expect_markers_match "#47" sns-bluesky sns-threads
in_app node /tmp/driver.mjs help sns-bluesky credentials || die "#47 手順書の本文が読めない"
in_app test -d /app/plugins/.torifune-bundled-backup/sns-bluesky || die "#47 sns-bluesky の退避が無い"
in_app grep -qF -- "$USER_EDIT" /app/plugins/sns-x-manual/README.md || die "#47 sns-x-manual の利用者の編集が消えた"
THREADS="$(in_app node /tmp/driver.mjs plugin sns-threads)"
grep -q '"detected":true' <<<"$THREADS" || die "#47 sns-threads が検出済みでない（DB の行がある？）: $THREADS"
log "OK #47 古い写しは置き換わり、利用者の編集は残り、消えたフォルダは戻った。手順書が読める"

# --- #48 -------------------------------------------------------------------
USER_FILES_AFTER="$(user_plugin_files)"
[ "$USER_FILES_AFTER" = "$USER_FILES_BEFORE" ] \
  || die "#48 利用者の Plugin のファイルが変わった: $USER_FILES_BEFORE / $USER_FILES_AFTER"
if in_app test -e "/app/plugins/$USER_PLUGIN/.torifune-bundled"; then
  die "#48 利用者の Plugin に同梱の印が付いた"
fi
log_has 'plugin sources differ from the build' || die "#48 起動時の突き合わせで食い違いを検出していない"
USER_STATE="$(in_app node /tmp/driver.mjs plugin "$USER_PLUGIN")"
grep -q '"status":"enabled"' <<<"$USER_STATE" || die "#48 利用者の Plugin が有効でない: $USER_STATE"
grep -q '"loaded":true' <<<"$USER_STATE" || die "#48 利用者の Plugin が読み込まれていない: $USER_STATE"
log "OK #48 利用者の Plugin は触られず、作り直しの後も有効で読み込まれている"

# --- #49 -------------------------------------------------------------------
log "#49 利用者の Plugin をファイルごと削除して再ビルドさせる"
in_app node /tmp/driver.mjs uninstall "$USER_PLUGIN"
# このコンテナでは起動前の再ビルドで 1 回出ているので、2 回目を待つ。
wait_for_log_count 'rebuild succeeded' 2
wait_for_app

in_app node -e "
const fs = require('node:fs');
const source = fs.readFileSync('/app/apps/web/src/plugin/generated-registry.ts', 'utf8');
const match = /directory: \"sns-bluesky\",\n\s*manifest: (.*),\n/.exec(source);
if (match === null) { console.error('sns-bluesky の項目が無い'); process.exit(1); }
const manifest = JSON.parse(match[1]);
const help = (manifest.help ?? []).find((doc) => doc.id === 'credentials');
if (help === undefined || help.path !== 'help/credentials.md') {
  console.error('sns-bluesky の help の宣言が無い'); process.exit(1);
}
" || die "#49 再ビルドの生成物に sns-bluesky の手順書の宣言が無い（古いソースから作られた）"
in_app node /tmp/driver.mjs help sns-bluesky credentials || die "#49 再ビルドの後に手順書の本文が読めない"

BUILD_FP="$(in_app cat /app/apps/web/.next/torifune-plugin-sources)"
# shellcheck disable=SC2086 # CLI はコマンドと引数を 1 つの文字列で持つ
NOW_FP="$(in_app $CLI plugins fingerprint --plugins-dir=/app/plugins)"
[ "$BUILD_FP" = "$NOW_FP" ] || die "#49 ビルドの指紋が Volume の指紋と違う: $BUILD_FP / $NOW_FP"
log "OK #49 再ビルドは更新済みのソースから作られ、ビルドの指紋が Volume と揃った"

log "すべて成功した（#43-#49）"
