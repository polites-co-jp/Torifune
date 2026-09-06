import { describe, expect, it } from 'vitest';
import {
  IP_EXCLUSION_MAX_RULES,
  IP_EXCLUSION_RULE_MAX_LENGTH,
  matchesAnyIpExclusion,
  normalizeClientIp,
  parseIpAddress,
  parseIpExclusionRule,
  parseIpExclusionRules,
} from './ip-exclusion';

/**
 * 033-analytics-ip-exclusion 設計 §4。受け入れ条件 #1〜#36。
 *
 * **判定は Domain に閉じている。** DB も HTTP も知らない関数群として検査する。
 */

/** テストの読みやすさのため、`Uint8Array` を配列で比べる。 */
function bytesOf(text: string): readonly number[] | null {
  const parsed = parseIpAddress(text);
  return parsed === null ? null : [...parsed.bytes];
}

describe('parseIpAddress', () => {
  // #1
  it('IPv4 を 4 バイトに読む', () => {
    const parsed = parseIpAddress('203.0.113.10');
    expect(parsed?.family).toBe('v4');
    expect(bytesOf('203.0.113.10')).toEqual([203, 0, 113, 10]);
  });

  // #2
  it('IPv6 を 16 バイトに読む', () => {
    const parsed = parseIpAddress('2001:db8::1');
    expect(parsed?.family).toBe('v6');
    expect(parsed?.bytes).toHaveLength(16);
    expect(bytesOf('2001:db8::1')).toEqual([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
  });

  /**
   * #3。**IPv4 射影は v4 に畳む。**
   * 畳まないと、同じ端末が Proxy の設定次第で片方だけ除外される（設計 §4.1）。
   */
  it('IPv4 射影アドレスを v4 の 4 バイトへ畳む', () => {
    const parsed = parseIpAddress('::ffff:203.0.113.10');
    expect(parsed?.family).toBe('v4');
    expect(bytesOf('::ffff:203.0.113.10')).toEqual([203, 0, 113, 10]);
  });

  it('IPv6 に埋め込んだ IPv4 表記を読む（射影でないもの）', () => {
    expect(bytesOf('64:ff9b::203.0.113.10')).toEqual([
      0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0, 203, 0, 113, 10,
    ]);
  });

  // #4
  it('先頭ゼロの IPv4 を認めない', () => {
    expect(parseIpAddress('010.0.0.1')).toBeNull();
    expect(parseIpAddress('203.0.113.01')).toBeNull();
  });

  // #5
  it.each(['256.0.0.1', '1.2.3', '1.2.3.4.5', '', '   ', '::ffff:', 'not-an-ip', '1.2.3.-1'])(
    '読めない値は null（%s）',
    (input) => {
      expect(parseIpAddress(input)).toBeNull();
    },
  );

  // #6
  it(':: は 1 回まで', () => {
    expect(parseIpAddress('2001:db8::1::2')).toBeNull();
  });

  // #7
  it(':: だけの表記を全 0 として読む', () => {
    const parsed = parseIpAddress('::');
    expect(parsed?.family).toBe('v6');
    expect(bytesOf('::')).toEqual(new Array<number>(16).fill(0));
  });

  it('大文字の IPv6 を読む', () => {
    expect(bytesOf('2001:DB8::1')).toEqual(bytesOf('2001:db8::1'));
  });

  // #8
  it('どんな入力でも例外を投げない', () => {
    for (const input of ['', ':', ':::', '/', '%', 'a'.repeat(500), '1:2:3:4:5:6:7:8:9']) {
      expect(() => parseIpAddress(input)).not.toThrow();
    }
  });
});

describe('normalizeClientIp', () => {
  // #9〜#15（設計 §4.2 の表）
  it.each([
    [' 203.0.113.10 ', '203.0.113.10'],
    ['203.0.113.10:51234', '203.0.113.10'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['fe80::1%eth0', 'fe80::1'],
    ['::ffff:203.0.113.10', '203.0.113.10'],
    ['not-an-ip', null],
  ])('%s → %s', (input, expected) => {
    expect(normalizeClientIp(input)).toBe(expected);
  });

  /**
   * #16。**コロンが複数ある値からポートを落とさない。**
   * 素の IPv6 を「アドレス:ポート」と読むと、末尾のグループが消える。
   */
  it('素の IPv6 からポートを落とさない', () => {
    expect(normalizeClientIp('2001:db8::1')).toBe('2001:db8::1');
  });

  // #17
  it('null と空文字は null', () => {
    expect(normalizeClientIp(null)).toBeNull();
    expect(normalizeClientIp(undefined)).toBeNull();
    expect(normalizeClientIp('')).toBeNull();
  });

  it('正規表記へそろえる（圧縮と小文字）', () => {
    expect(normalizeClientIp('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
  });
});

describe('parseIpExclusionRule', () => {
  // #18
  it('プレフィックス長を省略したら単体アドレスとして読む', () => {
    const rule = parseIpExclusionRule('203.0.113.10');
    expect(rule?.family).toBe('v4');
    expect(rule?.prefixLength).toBe(32);
    expect(rule?.text).toBe('203.0.113.10');
  });

  // #19
  it('/32 は表記から落とす', () => {
    expect(parseIpExclusionRule('203.0.113.10/32')?.text).toBe('203.0.113.10');
  });

  /**
   * #20。**ホスト部はマスクして正規化する**（設計 §4.3）。
   * 同じ帯を 2 通りに書いて 2 行になることを防ぐ。
   */
  it('ホスト部をマスクして正規化する', () => {
    const rule = parseIpExclusionRule('203.0.113.10/24');
    expect(rule?.text).toBe('203.0.113.0/24');
    expect([...(rule?.bytes ?? [])]).toEqual([203, 0, 113, 0]);
  });

  // #21
  it('IPv6 を小文字・:: 圧縮へそろえ、/128 を落とす', () => {
    expect(parseIpExclusionRule('2001:DB8:0:0:0:0:0:1/128')?.text).toBe('2001:db8::1');
  });

  // #22
  it('IPv6 の帯を正規表記にする', () => {
    expect(parseIpExclusionRule('2001:0db8:abcd:1234::/64')?.text).toBe('2001:db8:abcd:1234::/64');
  });

  it('IPv6 のホスト部もマスクする', () => {
    expect(parseIpExclusionRule('2001:db8:abcd:1234::99/64')?.text).toBe('2001:db8:abcd:1234::/64');
  });

  // #23
  it('プレフィックス長の境界', () => {
    expect(parseIpExclusionRule('203.0.113.0/0')?.text).toBe('0.0.0.0/0');
    expect(parseIpExclusionRule('203.0.113.10/32')).not.toBeNull();
    expect(parseIpExclusionRule('203.0.113.10/33')).toBeNull();
    expect(parseIpExclusionRule('2001:db8::/0')?.text).toBe('::/0');
    expect(parseIpExclusionRule('2001:db8::1/128')).not.toBeNull();
    expect(parseIpExclusionRule('2001:db8::1/129')).toBeNull();
  });

  // #24
  it.each(['203.0.113.0/024', '203.0.113.0/', '203.0.113.0/x', '203.0.113.0/1/2', '/24', ''])(
    '不正なルールは null（%s）',
    (input) => {
      expect(parseIpExclusionRule(input)).toBeNull();
    },
  );

  it('前後の空白を落とす', () => {
    expect(parseIpExclusionRule('  203.0.113.0/24  ')?.text).toBe('203.0.113.0/24');
  });
});

describe('matchesAnyIpExclusion', () => {
  function rulesOf(...texts: readonly string[]) {
    return texts.map((text) => {
      const rule = parseIpExclusionRule(text);
      if (rule === null) {
        throw new Error(`テストの前提が壊れている: ${text}`);
      }
      return rule;
    });
  }

  // #25
  it('完全一致', () => {
    const rules = rulesOf('203.0.113.10');
    expect(matchesAnyIpExclusion(rules, '203.0.113.10')).toBe(true);
    expect(matchesAnyIpExclusion(rules, '203.0.113.11')).toBe(false);
  });

  // #26
  it('CIDR の帯', () => {
    const rules = rulesOf('203.0.113.0/24');
    expect(matchesAnyIpExclusion(rules, '203.0.113.77')).toBe(true);
    expect(matchesAnyIpExclusion(rules, '203.0.114.1')).toBe(false);
  });

  // #27
  it('バイト境界でないプレフィックス長', () => {
    const rules = rulesOf('198.51.100.128/25');
    expect(matchesAnyIpExclusion(rules, '198.51.100.130')).toBe(true);
    expect(matchesAnyIpExclusion(rules, '198.51.100.255')).toBe(true);
    expect(matchesAnyIpExclusion(rules, '198.51.100.127')).toBe(false);
  });

  /**
   * #28。**family が違えば一致しない。**
   * `0.0.0.0/0` が IPv6 まで巻き込むと、設定した人の意図を超えて全部止まる。
   */
  it('family が違えば一致しない', () => {
    expect(matchesAnyIpExclusion(rulesOf('0.0.0.0/0'), '2001:db8::1')).toBe(false);
    expect(matchesAnyIpExclusion(rulesOf('::/0'), '203.0.113.10')).toBe(false);
  });

  // #29
  it('/0 は同じ family の全アドレスに一致する', () => {
    expect(matchesAnyIpExclusion(rulesOf('0.0.0.0/0'), '198.51.100.1')).toBe(true);
    expect(matchesAnyIpExclusion(rulesOf('::/0'), '2001:db8::1')).toBe(true);
  });

  // #30
  it('IPv4 射影アドレスは IPv4 の帯に一致する', () => {
    expect(matchesAnyIpExclusion(rulesOf('203.0.113.0/24'), '::ffff:203.0.113.10')).toBe(true);
  });

  it('IPv6 の帯に一致する', () => {
    const rules = rulesOf('2001:db8::/32');
    expect(matchesAnyIpExclusion(rules, '2001:db8:abcd::1')).toBe(true);
    expect(matchesAnyIpExclusion(rules, '2001:db9::1')).toBe(false);
  });

  // #31
  it('リストが空なら常に false', () => {
    expect(matchesAnyIpExclusion([], '203.0.113.10')).toBe(false);
  });

  it('読めないアドレスは一致しない', () => {
    expect(matchesAnyIpExclusion(rulesOf('0.0.0.0/0'), 'not-an-ip')).toBe(false);
  });

  it('ポート付き・角括弧付きの送信元でも判定できる', () => {
    expect(matchesAnyIpExclusion(rulesOf('203.0.113.0/24'), '203.0.113.10:51234')).toBe(true);
    expect(matchesAnyIpExclusion(rulesOf('2001:db8::/32'), '[2001:db8::1]:443')).toBe(true);
  });
});

describe('parseIpExclusionRules', () => {
  // #32
  it('空行と前後の空白を落とす', () => {
    const result = parseIpExclusionRules(['', '  ', ' 203.0.113.10 ']);
    expect(result.rules.map((rule) => rule.text)).toEqual(['203.0.113.10']);
    expect(result.invalid).toEqual([]);
  });

  // #33
  it('正規表記が同じ行を 1 つに畳む', () => {
    const result = parseIpExclusionRules(['203.0.113.0/24', '203.0.113.10/24']);
    expect(result.rules.map((rule) => rule.text)).toEqual(['203.0.113.0/24']);
  });

  // #34
  it('解釈できない行は invalid へ入力のまま入る', () => {
    const result = parseIpExclusionRules(['203.0.113.10', 'not-an-ip', '203.0.113.0/33']);
    expect(result.rules.map((rule) => rule.text)).toEqual(['203.0.113.10']);
    expect(result.invalid).toEqual(['not-an-ip', '203.0.113.0/33']);
  });

  // #35
  it('長すぎる行は invalid', () => {
    const long = `203.0.113.10${' '.repeat(0)}${'0'.repeat(IP_EXCLUSION_RULE_MAX_LENGTH)}`;
    expect(long.length).toBeGreaterThan(IP_EXCLUSION_RULE_MAX_LENGTH);
    expect(parseIpExclusionRules([long]).invalid).toEqual([long]);
  });

  // #36
  it('入力順を保つ', () => {
    const result = parseIpExclusionRules(['198.51.100.0/24', '203.0.113.10', '2001:db8::/32']);
    expect(result.rules.map((rule) => rule.text)).toEqual([
      '198.51.100.0/24',
      '203.0.113.10',
      '2001:db8::/32',
    ]);
  });

  it('上限は 100 件', () => {
    expect(IP_EXCLUSION_MAX_RULES).toBe(100);
  });
});
