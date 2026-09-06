'use client';

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { chartHitTest, type ChartHoverPoint, type ChartTone } from './chart-geometry';

/**
 * 折れ線チャートのホバー（031 設計 §7.1〜§7.5）。
 *
 * **`'use client'` はここだけに置く**（要件 §6-1 の追加裁定 / 設計 §13）。
 * `chart.tsx` は Server Component のままで、`fallback`（`ReactNode`）は
 * server → client の境界を越えない。Plugin の Server Component が
 * `<Chart fallback={<Table … render={…} />} />` と書いても直列化で落ちない。
 *
 * 受け取るのは `ChartHoverPoint` の配列だけである。文字列と数値しか持たない。
 *
 * **不可視の矩形を点ごとに置かない。** SVG の箱ちょうどに重なる `<div>` を 1 枚だけ置き、
 * そこで `pointermove` を受けて `chartHitTest`（純関数）へ渡す。
 * 点ごとに要素を置くと 90 日 × 2 系列で 180 個増え、点と点の中間に穴ができる。
 */

const TONE_COLORS: Record<ChartTone, string> = {
  'chart-1': 'var(--tf-color-chart-1)',
  'chart-2': 'var(--tf-color-chart-2)',
};

/** マーカーとポップアップは自分で当たり判定を遮らない（遮ると点が切り替わって暴れる）。 */
const DECORATION: CSSProperties = {
  position: 'absolute',
  pointerEvents: 'none',
};

export function ChartHoverLayer({ points }: { readonly points: readonly ChartHoverPoint[] }) {
  const areaRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<ChartHoverPoint | null>(null);

  // **出ている間だけ**リスナを張る（設計 §7.4 / §11.5）。
  // 出ていないチャートがページに何枚あっても、常時のリスナは増えない。
  //
  // `points.length === 0` も見る。点が空になった瞬間は下の早期 return で膜ごと消えるので、
  // `active` が残っていても指せる相手がいない。DOM が消えたあとにリスナだけ残さない。
  useEffect(() => {
    if (active === null || points.length === 0) {
      return;
    }

    // 膜の外での押下で閉じる。タッチで出しっぱなしになったものを閉じる手段。
    const onDocumentPointerDown = (event: globalThis.PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && areaRef.current?.contains(target) === true) {
        return;
      }
      setActive(null);
    };
    // `Modal` が `window` の `keydown` で `Escape` を拾っている作法に揃える。
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setActive(null);
      }
    };

    document.addEventListener('pointerdown', onDocumentPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [active, points.length]);

  // 指せる点が 1 つも無ければ膜を出さない。
  // `chartHoverPoints` が非有限の点を落として空になった場合もここで塞がる。
  if (points.length === 0) {
    return null;
  }

  /**
   * カーソル位置を膜の箱に対する割合へ直して、最も近い点を引き直す。
   *
   * **`offsetX` / `offsetY` を使わない**（設計 §11.4）。膜の中にはマーカーと
   * ポップアップという子要素があり、基準がそちらへずれうる。要素で固定する。
   * 読み取り（`getBoundingClientRect`）を先に済ませ、書き込みは React の次の描画へ回す。
   */
  const pick = (event: PointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      // 非表示・折り畳み中。0 除算で `chartHitTest` に NaN を渡す経路を作らない。
      return;
    }

    const hit = chartHitTest(
      points,
      ((event.clientX - rect.left) / rect.width) * 100,
      ((event.clientY - rect.top) / rect.height) * 100,
    );
    // `chartHitTest` は配列の要素をそのまま返すので、参照比較 1 回で済む（設計 §11.3）。
    setActive((current) => (current === hit ? current : hit));
  };

  return (
    <div
      ref={areaRef}
      aria-hidden="true"
      data-chart-hover-area=""
      onPointerMove={pick}
      onPointerDown={pick}
      onPointerLeave={(event) => {
        // **タッチでは消さない**（設計 §7.4）。指を離した直後に `pointerleave` が飛ぶので、
        // ここで消すと指の下に隠れていた値を読む前に消える。
        if (event.pointerType !== 'touch') {
          setActive(null);
        }
      }}
      onPointerCancel={() => setActive(null)}
      style={{
        position: 'absolute',
        inset: 0,
        // 縦スクロールと**二本指の拡大**は渡す。横は当たり判定に使うので渡さない。
        // `pinch-zoom` を落とすと、細い線と小さな文字の集まりであるチャートの上でだけ
        // 拡大が効かなくなる（WCAG 1.4.4。設計 §7.4）。奪ってよいのは横のパンだけ。
        touchAction: 'pan-y pinch-zoom',
      }}
    >
      {active !== null && (
        <>
          {/*
            マーカーは HTML の `<span>` にする。SVG の `<circle>` は
            `preserveAspectRatio="none"` の下で横に潰れた楕円になる（設計 §7.1）。
          */}
          <span
            data-chart-marker=""
            style={{
              ...DECORATION,
              left: `${active.xPercent}%`,
              top: `${active.yPercent}%`,
              transform: 'translate(-50%, -50%)',
              width: 'var(--tf-space-2)',
              height: 'var(--tf-space-2)',
              borderRadius: 'var(--tf-radius-pill)',
              background: TONE_COLORS[active.tone],
              boxShadow: '0 0 0 var(--tf-border-emphasis) var(--tf-color-bg)',
            }}
          />

          {/*
            はみ出しは点の左右・上下への振り分けと、幅 `calc(50% - var(--tf-space-2))` /
            高さ `50%` の上限で規則から言える（設計 §7.5）。寸法・文字数・フォントに依存しない。
            **左右と上下で値が違うのは、点から離しているのが左右だけだからである**
            （左右は `--tf-space-2` ぶん離すのでその量を上限から差し引く。上下は離していないので
            差し引く量が無い）。**揃え忘れではないので、上下を `calc` に直さないこと。**
            `z-index` を書かない。重なる相手は同じ入れ物の中の `<svg>` だけで、文書順で決まる。
          */}
          <div
            data-chart-tooltip=""
            style={{
              ...DECORATION,
              ...(active.xPercent <= 50
                ? { left: `${active.xPercent}%`, marginLeft: 'var(--tf-space-2)' }
                : { right: `${100 - active.xPercent}%`, marginRight: 'var(--tf-space-2)' }),
              ...(active.yPercent <= 50
                ? { top: `${active.yPercent}%` }
                : { bottom: `${100 - active.yPercent}%` }),
              // **離す量を上限から差し引く**（設計 §7.5）。`50%` のままだと
              // `xPercent = 50` のときに `50% + 8px + 50%` で右端を 8px はみ出す。
              maxWidth: 'calc(50% - var(--tf-space-2))',
              // 上下は点から離していないので、差し引く量が無い。同じ論法で上限は `50%`
              // （左半分なら下端 ≤ `y% + 50%` ≤ `100%`。右半分・上下対称も同じ）。
              maxHeight: '50%',
              display: 'grid',
              gap: 'var(--tf-space-1)',
              padding: 'var(--tf-space-2)',
              background: 'var(--tf-color-bg)',
              border: '1px solid var(--tf-color-border)',
              borderRadius: 'var(--tf-radius-md)',
              boxShadow: 'var(--tf-shadow-1)',
              lineHeight: 1.4,
            }}
          >
            {/* 1 系列の経路では系列名を出さない。区別すべき相手がいない（設計 §7.3）。 */}
            {active.seriesLabel !== '' && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--tf-space-2)',
                  fontSize: 'var(--tf-text-label)',
                  color: 'var(--tf-color-text-muted)',
                }}
              >
                <span
                  style={{
                    display: 'inline-block',
                    flex: 'none',
                    width: 'var(--tf-space-2)',
                    height: 'var(--tf-space-2)',
                    borderRadius: 'var(--tf-radius-pill)',
                    background: TONE_COLORS[active.tone],
                  }}
                />
                {active.seriesLabel}
              </span>
            )}
            <span style={{ fontSize: 'var(--tf-text-label)', color: 'var(--tf-color-text-muted)' }}>
              {active.label}
            </span>
            {/* 数の形は `chart.tsx` の軸ラベルと揃える。単位は付けない（`ChartPoint` は持たない）。 */}
            <span style={{ fontFamily: 'var(--tf-font-mono)', fontSize: 'var(--tf-text-body)' }}>
              {active.value.toLocaleString('ja-JP')}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
