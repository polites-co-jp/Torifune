import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { declarePublicUseCase } from '@/application/authorization/use-case';
import { withConnection } from '@/application/transaction';
import {
  deviceKindOf,
  normalizePath,
  referrerHostOf,
  visitorHash,
} from '@/domain/analytics/access-log';
import { todayInTimeZone } from '@/domain/analytics/day';
import { analyticsRepository } from '@/infrastructure/analytics-repository';
import { analyticsTimeZone } from './timezone';

/**
 * アクセスの記録（018-analytics 設計 §3）。
 *
 * **認証しない。** 計測タグは閲覧者のブラウザから叩かれるため、
 * 認証のしようがない。サイトの公開キーで識別する。
 *
 * `defineUseCase` の形に収まらないので、`declarePublicUseCase` で
 * 「認可されていない処理」の一覧へ明示的に載せる。
 */
declarePublicUseCase(
  'analytics.collect',
  '計測タグは閲覧者のブラウザから叩かれる。認証できないため、サイトの公開キーで識別する',
);

/**
 * 日ごとのソルト。
 *
 * **プロセス内で日ごとに作り、保存しない。** 保存すると、
 * 過去のソルトでハッシュを再計算して同じ人を追える。
 *
 * 再起動でソルトが変わると、その日の訪問者が二重に数えられる。
 * それを避けるには保存が要るが、**追跡できてしまうほうが問題**なので、
 * 数え漏れを受け入れる（設計 §3.2）。
 */
const salts = new Map<string, string>();

function dailySalt(day: string): string {
  const existing = salts.get(day);
  if (existing !== undefined) {
    return existing;
  }

  // 古い日のソルトは捨てる。持ち続けても使わず、漏れる面が増えるだけ。
  salts.clear();

  const salt = randomBytes(32).toString('hex');
  salts.set(day, salt);
  return salt;
}

/**
 * ソルトを回す日付。
 *
 * **集計の1日の境目と必ずそろえる。** ずれると、1つの集計日の途中で
 * ソルトが変わり、同じ訪問者が2人と数えられる。
 */
function saltDay(now: Date): string {
  return todayInTimeZone(analyticsTimeZone(), now);
}

export interface CollectInput {
  readonly publicKey: string;
  readonly path: string;
  readonly referrer: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export type CollectOutcome =
  | { readonly ok: true }
  /** 理由は呼び出し側へ伝えない。伝えるとキーの当たりを探れる。 */
  | { readonly ok: false };

export async function collectAccess(input: CollectInput): Promise<CollectOutcome> {
  const path = normalizePath(input.path);
  if (path === null) {
    return { ok: false };
  }

  return withConnection(async (connection) => {
    const site = await analyticsRepository.findSiteByPublicKey(connection, input.publicKey);

    // 存在しないキーと停止中のサイトを区別しない。
    if (site === null || site.status === 'archived') {
      return { ok: false };
    }

    const now = new Date();
    const device = deviceKindOf(input.userAgent);

    await analyticsRepository.recordAccess(connection, {
      id: uuidv7(),
      siteId: site.id,
      path,
      referrerHost: referrerHostOf(input.referrer),
      // **IP と User-Agent の生値は保存しない。**
      visitorHash: visitorHash({
        dailySalt: dailySalt(saltDay(now)),
        siteId: site.id,
        // IP が取れない場合も一意性は User-Agent 側で担保する。
        ipAddress: input.ipAddress ?? 'unknown',
        userAgent: input.userAgent ?? '',
      }),
      device,
    });

    return { ok: true };
  });
}

/** テスト用。ソルトを作り直させる。 */
export function resetDailySalts(): void {
  salts.clear();
}

/**
 * 計測スクリプト。
 *
 * **最小にする。** Cookie も localStorage も使わず、`sendBeacon` で叩くだけ
 * （設計 §3.4）。Cookie を使うと同意取得の話が乗ってきて、導入の敷居が上がる。
 *
 * **ロード時だけでなく、SPA のクライアント遷移でも送る。** Next.js 等の SPA では
 * リンクを辿っても `<head>` が再描画されず、スクリプトは再実行されない。
 * `history.pushState` / `replaceState` を包み、`popstate` を聞いて、
 * pathname が変わるたびに送る。これが無いと、サイト内回遊の PV が丸ごと欠ける。
 *
 * - **公開キーは初回実行時に閉じ込める。** `document.currentScript` は
 *   後続のコールバック内では `null` になる。遷移時に読み直すと必ず壊れる。
 * - **pathname が実際に変わったときだけ送る。** SPA はスクロール復元や
 *   クエリ更新で `replaceState` を連発する。受け口は query を捨てて path だけを
 *   保存するので、判定も pathname で行う。ハッシュだけの変化も数えない。
 * - **`pushState` / `replaceState` の包みは元の挙動を変えない。** 戻り値・`this`・
 *   引数をそのまま通し、送信は元関数を呼んだ**後**に行う（URL が変わってから読む）。
 *   送信側の例外はホストサイトのナビゲーションへ漏らさない。
 * - **タグが2回貼られても二重に入らない。** `window.__torifune` で見張る。
 * - **遷移時の referrer は `null`。** `document.referrer` は SPA の間ずっと
 *   外部流入元のままなので、遷移ごとに送ると流入元が実数以上に膨らむ。
 *   初回ロードだけ `document.referrer` を送る。
 * - **bfcache からの復帰（`pageshow`）は数えない。** 戻った先はすでに数えた
 *   ページであり、スクリプトの状態も凍結されたまま戻る。
 *
 * **Content-Type を `text/plain` にする。** このスクリプトは他所のサイトへ貼られ、
 * 受け口とは別オリジンになる。`application/json` は CORS のセーフリスト外なので、
 * 送るたびにプリフライト（`OPTIONS`）が飛ぶ。CORS は既定で無効であり
 * （`api/cors.ts`）、貼ったサイトのオリジンを `TORIFUNE_CORS_ORIGINS` へ
 * 足さない限り、計測がまるごと落ちる。
 *
 * **計測のために CORS を開かせない。** 開かせると、そのオリジンから
 * `/api/v1` の参照系まで開くことになり、計測の代償として広すぎる。
 * セーフリストの `text/plain` なら単純リクエストになり、プリフライトが起きない。
 * 受け口は Content-Type を見ずに本文を JSON として読むため、受け側の変更は要らない。
 */
export function trackingScript(origin: string): string {
  return `(function(){
try{
var s=document.currentScript;
var k=s&&s.getAttribute('data-site');
if(!k)return;
if(window.__torifune)return;
window.__torifune=1;
var u=${JSON.stringify(`${origin}/api/v1/collect`)};
var l=null;
function send(r){
var p=location.pathname;
if(p===l)return;
l=p;
var b=JSON.stringify({key:k,path:p,referrer:r});
if(navigator.sendBeacon){navigator.sendBeacon(u,new Blob([b],{type:'text/plain;charset=UTF-8'}));}
else{var x=new XMLHttpRequest();x.open('POST',u,true);x.setRequestHeader('Content-Type','text/plain;charset=UTF-8');x.send(b);}
}
function spa(){try{send(null);}catch(e){}}
function hook(n){
var o=history[n];
if(typeof o!=='function')return;
history[n]=function(){var r=o.apply(this,arguments);spa();return r;};
}
hook('pushState');
hook('replaceState');
addEventListener('popstate',spa);
send(document.referrer||null);
}catch(e){}
})();`;
}

/** スクリプトの内容が変わったかを見分ける。キャッシュの検証に使う。 */
export function trackingScriptEtag(origin: string): string {
  return `"${createHash('sha256').update(trackingScript(origin)).digest('hex').slice(0, 16)}"`;
}
