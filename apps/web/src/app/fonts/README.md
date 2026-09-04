# 同梱フォント / Bundled fonts

画面の書体は `next/font/local` でこのディレクトリから読む（`app/layout.tsx`）。
**ビルド時にも実行時にも外部のフォント配信（Google Fonts 等）へ接続しない。**

All fonts are self-hosted from this directory via `next/font/local`.
Neither the build nor the running application connects to any external font service.

## ライセンス / License

3 書体とも **SIL Open Font License, Version 1.1 (OFL-1.1)**。
各書体の OFL 本文（著作権表示を含む）を `LICENSE-*.txt` として同梱している。

All three typefaces are licensed under the SIL Open Font License 1.1.
The full license text for each, including its copyright notice, is in `LICENSE-*.txt`.

## 出所 / Sources

| ファイル                    | 書体                                 | バージョン                  | 出所                                                                                                                                                                    | ライセンス本文                                         |
| --------------------------- | ------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `Inter[wght].woff2`         | Inter（可変、wght 100–900）          | 4.1                         | <https://github.com/rsms/inter/releases/tag/v4.1> の `Inter-4.1.zip` 内 `web/InterVariable.woff2` をそのまま                                                            | `LICENSE-Inter.txt`（同 zip の `LICENSE.txt`）         |
| `JetBrainsMono[wght].woff2` | JetBrains Mono（可変、wght 100–800） | 2.304                       | <https://github.com/JetBrains/JetBrainsMono/releases/tag/v2.304> の `JetBrainsMono-2.304.zip` 内 `fonts/variable/JetBrainsMono[wght].ttf` を woff2 に変換               | `LICENSE-JetBrainsMono.txt`（同 zip の `OFL.txt`）     |
| `NotoSansJP[wght].woff2`    | Noto Sans JP（可変、wght 100–900）   | 2.004（`Version 2.004-H2`） | <https://github.com/google/fonts/tree/main/ofl/notosansjp> の `NotoSansJP[wght].ttf`（commit `66a36c8`、上流は <https://github.com/notofonts/noto-cjk>）を woff2 に変換 | `LICENSE-NotoSansJP.txt`（同ディレクトリの `OFL.txt`） |

取得日：2026-09-04

### woff2 への変換

JetBrains Mono と Noto Sans JP は、配布元が可変フォントを TTF でしか出していないため、
Google の woff2 エンコーダ（WebAssembly 版 [`wawoff2`](https://www.npmjs.com/package/wawoff2) 2.0.1）で変換した。
変換は無損失で、字形・可変軸は TTF と同じ。

```bash
pnpm --package=wawoff2 dlx woff2_compress.js 'NotoSansJP[wght].ttf' 'NotoSansJP[wght].woff2'
pnpm --package=wawoff2 dlx woff2_compress.js 'JetBrainsMono[wght].ttf' 'JetBrainsMono[wght].woff2'
```

## 使い方 / Usage

`app/layout.tsx` が 3 書体を CSS 変数 `--font-inter` / `--font-jetbrains-mono` / `--font-noto-sans-jp` として
`<html>` に付け、`ui/tokens.css` の `--tf-font-sans` / `--tf-font-mono` がそれを参照する。
Noto Sans JP は大きい（約 4.3 MB）ので `preload: false` にし、初回描画を待たせない。

## 更新手順 / Updating

1. 上の出所から新しいリリースを取る（Inter は zip 内の `web/InterVariable.woff2`、
   他 2 書体は可変 TTF を上のコマンドで woff2 に変換する）
2. 同名で上書きし、`LICENSE-*.txt` も配布物のものへ差し替える
3. この README のバージョン・取得日・commit を更新する
4. `pnpm test`（`ui/ui-shell.test.ts` の「フォント」）と `pnpm build` を通す
