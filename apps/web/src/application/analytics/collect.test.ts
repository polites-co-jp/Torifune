import { describe, expect, it } from 'vitest';
import { trackingScript, trackingScriptEtag } from '@/application/analytics/collect';

/**
 * 計測スクリプト（018-analytics 設計 §3.4）。
 *
 * **他所のサイトへ貼られる。** 別オリジンから叩かれても
 * プリフライトが起きない形であることを、ここで固定する。
 */
describe('trackingScript', () => {
  const script = trackingScript('https://torifune.example.com');

  it('受け口の絶対URLを埋め込む', () => {
    // 貼られる側のオリジンでは相対パスが別のサーバーを指す。
    expect(script).toContain('https://torifune.example.com/api/v1/collect');
  });

  it('プリフライトを起こす Content-Type を使わない', () => {
    // application/json は CORS セーフリスト外。別オリジンへ送ると
    // OPTIONS が飛び、TORIFUNE_CORS_ORIGINS に載っていないサイトの計測が
    // まるごと落ちる。text/plain はセーフリストなので単純リクエストになる。
    expect(script).not.toContain('application/json');
    expect(script).toContain('text/plain');
  });

  it('Cookie を使わない', () => {
    // Cookie を使うと同意取得の話が乗ってきて、導入の敷居が上がる。
    expect(script).not.toContain('document.cookie');
  });

  it('オリジンごとに ETag が変わる', () => {
    expect(trackingScriptEtag('https://a.example.com')).not.toBe(
      trackingScriptEtag('https://b.example.com'),
    );
  });
});
