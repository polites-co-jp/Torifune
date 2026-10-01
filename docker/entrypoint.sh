#!/bin/sh
# Torifune コンテナのエントリポイント。
#
# Plugin の導入・削除はビルド成果物を変えるため、アプリケーションの再ビルドが要る。
# アプリは再ビルドが必要になると sentinel を書いて終了コード 75 で落ちる。
# ここがそれを受けて再ビルドし、起動し直す。
#
# 起動の手順（監視ループに入る前に 1 回ずつ）:
#   1. 同梱 Plugin の同期。イメージに残した同梱 Plugin の写し（TORIFUNE_BUNDLED_PLUGINS_DIR）を
#      plugins の Volume へ反映する。Volume はイメージを更新しても中身が変わらないため。
#      更新するのは同梱 Plugin だけで、利用者が導入・変更した Plugin には触れない。
#      失敗しても起動は止めない。
#   2. 起動時の突き合わせ。Volume の Plugin のソースの指紋と、いまのビルドが作られたソースの指紋
#      （$NEXT_DIR/torifune-plugin-sources）を比べ、食い違えば起動の前に 1 回だけ再ビルドする。
#      コンテナを作り直すと .next はイメージに焼かれたものに戻り、利用者が導入した Plugin が
#      ビルドから消えるため。
# 再ビルドが成功したら、ビルドの前に計算した指紋を .next の中に書く。巻き戻しは .next を
# まるごと戻すので、指紋もビルドと一緒に戻る。監視ループの中の再ビルドは指紋を見ずに必ず走る。
#
# 詳細: docs/実装計画/001-Torifune単体稼働/00_決定事項.md D-02
#       docs/設計/050-bundled-plugin-sync/設計.md §6.5・§6.7
set -eu

REBUILD_EXIT_CODE=75
SENTINEL="${TORIFUNE_REBUILD_SENTINEL:-/app/.torifune-rebuild-request}"
STATE_DIR="${TORIFUNE_BUILD_STATE_DIR:-/app/.torifune-build-state}"
NEXT_DIR="${TORIFUNE_NEXT_DIR:-/app/apps/web/.next}"
PLUGINS_DIR="${TORIFUNE_PLUGINS_DIR:-/app/plugins}"
BUNDLED_DIR="${TORIFUNE_BUNDLED_PLUGINS_DIR:-}"
# 起動・ビルド・CLI のコマンド。テストからスタブへ差し替えられるようにしている。
START_CMD="${TORIFUNE_START_CMD:-pnpm --filter @torifune/web start}"
CLI="${TORIFUNE_CLI_CMD:-node /app/packages/cli/dist/main.js}"
FINGERPRINT_FILE="$NEXT_DIR/torifune-plugin-sources"

mkdir -p "$STATE_DIR"

rebuild() {
  echo "[torifune] rebuilding after plugin change..."

  # ビルドに入るソースの指紋は、ビルドの前に計算する（pnpm build は CLI も作り直し、
  # next build は .next を消してから作る）。計算できなければ、ビルドはするが指紋は書かない
  # （次の起動で食い違いとして扱われる）。
  # shellcheck disable=SC2086
  if ! fingerprint=$($CLI plugins fingerprint --plugins-dir="$PLUGINS_DIR"); then
    echo "[torifune] could not fingerprint plugins - the build will not record its sources" >&2
    fingerprint=""
  fi

  # 直前の成功ビルドを退避しておき、失敗したら戻す。
  rm -rf "$STATE_DIR/last-good"
  if [ -d "$NEXT_DIR" ]; then
    cp -a "$NEXT_DIR" "$STATE_DIR/last-good"
  fi

  # レジストリの再生成もビルドに含める（pnpm build が generate:plugins を先に走らせる）。
  # アプリ側で生成すると、生成の実体が2箇所になって必ずずれる。
  if ${TORIFUNE_BUILD_CMD:-pnpm build}; then
    echo "[torifune] rebuild succeeded"
    # .next が無ければ作らない（次の起動で食い違いとして扱われ、もう一度ビルドされる）。
    if [ -n "$fingerprint" ] && [ -d "$NEXT_DIR" ]; then
      if ! printf '%s\n' "$fingerprint" > "$FINGERPRINT_FILE"; then
        echo "[torifune] could not record the plugin sources of the build" >&2
      fi
    fi
    return 0
  fi

  echo "[torifune] rebuild FAILED - rolling back to the last good build" >&2
  rm -rf "$NEXT_DIR"
  if [ -d "$STATE_DIR/last-good" ]; then
    cp -a "$STATE_DIR/last-good" "$NEXT_DIR"
  fi
  return 1
}

# 1. 同梱 Plugin の同期（設計 §6.5）。
if [ -n "$BUNDLED_DIR" ]; then
  # shellcheck disable=SC2086
  if ! $CLI plugins sync-bundled --bundled-dir="$BUNDLED_DIR" --plugins-dir="$PLUGINS_DIR"; then
    echo "[torifune] bundled plugin sync FAILED - continuing with the current plugins" >&2
  fi
fi

# 2. 起動時の突き合わせ（設計 §6.7.3）。起動の前の再ビルドは多くても 1 回。
if [ -f "$SENTINEL" ]; then
  rm -f "$SENTINEL"
  rebuild || echo "[torifune] continuing with the previous build" >&2
else
  # shellcheck disable=SC2086
  if ! current_fingerprint=$($CLI plugins fingerprint --plugins-dir="$PLUGINS_DIR"); then
    echo "[torifune] could not fingerprint plugins - starting with the current build" >&2
  else
    build_fingerprint=""
    if [ -f "$FINGERPRINT_FILE" ]; then
      build_fingerprint=$(cat "$FINGERPRINT_FILE" 2>/dev/null) || build_fingerprint=""
    fi
    if [ -z "$build_fingerprint" ] || [ "$current_fingerprint" != "$build_fingerprint" ]; then
      echo "[torifune] plugin sources differ from the build - rebuilding before start"
      rebuild || echo "[torifune] continuing with the previous build" >&2
    fi
  fi
fi

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
