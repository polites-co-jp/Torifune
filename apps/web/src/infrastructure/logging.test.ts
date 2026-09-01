import { afterEach, describe, expect, it, vi } from 'vitest';
import { Secret } from '@/domain/secret';
import { log, maskSecrets, resetLogger, setLogger, type LogRecord } from './logging';

function capture(): { records: LogRecord[] } {
  const records: LogRecord[] = [];
  setLogger({
    log(level, message, fields) {
      records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    },
  });
  return { records };
}

afterEach(() => {
  resetLogger();
  vi.restoreAllMocks();
});

describe('maskSecrets', () => {
  it('Secret を平文で出さない', () => {
    const masked = maskSecrets({ apiKey: new Secret('sk-live-1234') });
    expect(JSON.stringify(masked)).not.toContain('sk-live-1234');
  });

  it('機密になりうるキーの値を落とす', () => {
    const masked = maskSecrets({
      password: 'hunter2',
      accessToken: 'abc',
      user_secret: 'xyz',
      sessionId: 'sid',
      authorization: 'Bearer t',
    }) as Record<string, unknown>;

    expect(JSON.stringify(masked)).not.toContain('hunter2');
    expect(JSON.stringify(masked)).not.toContain('abc');
    expect(JSON.stringify(masked)).not.toContain('xyz');
    expect(JSON.stringify(masked)).not.toContain('sid');
    expect(JSON.stringify(masked)).not.toContain('Bearer t');
  });

  it('機密でないキーは残す', () => {
    const masked = maskSecrets({ siteId: 'site_1', count: 3 }) as Record<string, unknown>;
    expect(masked['siteId']).toBe('site_1');
    expect(masked['count']).toBe(3);
  });

  it('入れ子の中の機密も落とす', () => {
    const masked = maskSecrets({ outer: { inner: { password: 'hunter2' } } });
    expect(JSON.stringify(masked)).not.toContain('hunter2');
  });

  it('配列の中の機密も落とす', () => {
    const masked = maskSecrets([{ token: 'abc' }, { name: 'ok' }]);
    expect(JSON.stringify(masked)).not.toContain('abc');
    expect(JSON.stringify(masked)).toContain('ok');
  });

  /** 循環参照で落とさない。ログの整形でアプリを止めては本末転倒。 */
  it('循環参照でも例外を投げない', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;
    expect(() => maskSecrets(cyclic)).not.toThrow();
  });
});

describe('log', () => {
  it('差し替えた Logger へ渡す', () => {
    const { records } = capture();
    log.info('something happened', { siteId: 'site_1' });

    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe('info');
    expect(records[0]?.message).toBe('something happened');
    expect(records[0]?.fields).toEqual({ siteId: 'site_1' });
  });

  it('4つのレベルを扱える', () => {
    const { records } = capture();
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(records.map((r) => r.level)).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('fields の機密を落としてから渡す', () => {
    const { records } = capture();
    log.error('failed', { password: 'hunter2', operationId: 'sites.list' });

    const serialized = JSON.stringify(records[0]?.fields);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).toContain('sites.list');
  });

  /**
   * ログの失敗でアプリを止めない。
   * 出力先が壊れていることと、処理が続けられないことは別。
   */
  it('Logger が例外を投げても呼び出し元へ伝えない', () => {
    setLogger({
      log() {
        throw new Error('sink is down');
      },
    });
    expect(() => log.info('x')).not.toThrow();
  });
});

describe('既定の Logger', () => {
  it('1行の JSON を書き出す', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    resetLogger();

    log.error('boom', { operationId: 'sites.list' });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0] as string;
    expect(line.includes('\n')).toBe(false);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed['level']).toBe('error');
    expect(parsed['message']).toBe('boom');
  });

  it('error 以外は console.error を使わない', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resetLogger();

    log.info('hello');

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
