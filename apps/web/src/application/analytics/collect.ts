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
import { analyticsRepository } from '@/infrastructure/analytics-repository';

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

/** ローカルの `YYYY-MM-DD`。 */
function today(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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
    const site = await connection.db
      .selectFrom('sites')
      .select(['id', 'status'])
      .where('public_key', '=', input.publicKey)
      .executeTakeFirst();

    // 存在しないキーと停止中のサイトを区別しない。
    if (site === undefined || site.status === 'archived') {
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
        dailySalt: dailySalt(today(now)),
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
 * **最小にする。** Cookie を使わず、`sendBeacon` で1回叩くだけ
 * （設計 §3.4）。Cookie を使うと同意取得の話が乗ってきて、導入の敷居が上がる。
 */
export function trackingScript(origin: string): string {
  return `(function(){
try{
var s=document.currentScript;
var k=s&&s.getAttribute('data-site');
if(!k)return;
var b=JSON.stringify({key:k,path:location.pathname,referrer:document.referrer||null});
var u=${JSON.stringify(origin)}+'/api/v1/collect';
if(navigator.sendBeacon){navigator.sendBeacon(u,new Blob([b],{type:'application/json'}));}
else{var x=new XMLHttpRequest();x.open('POST',u,true);x.setRequestHeader('Content-Type','application/json');x.send(b);}
}catch(e){}
})();`;
}

/** スクリプトの内容が変わったかを見分ける。キャッシュの検証に使う。 */
export function trackingScriptEtag(origin: string): string {
  return `"${createHash('sha256').update(trackingScript(origin)).digest('hex').slice(0, 16)}"`;
}
