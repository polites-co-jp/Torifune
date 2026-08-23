#!/bin/sh
# Torifune コンテナのエントリポイント。
#
# Plugin の導入・削除はビルド成果物を変えるため、アプリケーションの再ビルドが要る。
# アプリは再ビルドが必要になると sentinel を書いて終了コード 75 で落ちる。
# ここがそれを受けて再ビルドし、起動し直す。
#
# 詳細: docs/実装計画/001-Torifune単体稼働/00_決定事項.md D-02
set -eu

REBUILD_EXIT_CODE=75
SENTINEL="${TORIFUNE_REBUILD_SENTINEL:-/app/.torifune-rebuild-request}"
STATE_DIR="${TORIFUNE_BUILD_STATE_DIR:-/app/.torifune-build-state}"
# 起動コマンド。テストからスタブへ差し替えられるようにしている。
START_CMD="${TORIFUNE_START_CMD:-pnpm --filter @torifune/web start}"

mkdir -p "$STATE_DIR"

rebuild() {
  echo "[torifune] rebuilding after plugin change..."

  # 直前の成功ビルドを退避しておき、失敗したら戻す。
  rm -rf "$STATE_DIR/last-good"
  if [ -d /app/apps/web/.next ]; then
    cp -a /app/apps/web/.next "$STATE_DIR/last-good"
  fi

  if ${TORIFUNE_BUILD_CMD:-pnpm --filter @torifune/web build}; then
    echo "[torifune] rebuild succeeded"
    return 0
  fi

  echo "[torifune] rebuild FAILED - rolling back to the last good build" >&2
  rm -rf /app/apps/web/.next
  if [ -d "$STATE_DIR/last-good" ]; then
    cp -a "$STATE_DIR/last-good" /app/apps/web/.next
  fi
  return 1
}

while true; do
  if [ -f "$SENTINEL" ]; then
    rm -f "$SENTINEL"
    rebuild || echo "[torifune] continuing with the previous build" >&2
  fi

  set +e
  # shellcheck disable=SC2086
  $START_CMD
  status=$?
  set -e

  if [ "$status" -eq "$REBUILD_EXIT_CODE" ]; then
    echo "[torifune] restart requested"
    continue
  fi

  exit "$status"
done
