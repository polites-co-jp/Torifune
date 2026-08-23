import { describe, expect, it } from 'vitest';
import { isCommand, usage } from './index.js';

describe('isCommand', () => {
  it('既知のコマンドを受け付ける', () => {
    expect(isCommand('migrate')).toBe(true);
  });

  it('未知のコマンドを拒否する', () => {
    expect(isCommand('drop-everything')).toBe(false);
  });
});

describe('usage', () => {
  it('migrate の使い方を含む', () => {
    expect(usage()).toContain('migrate --database-url');
  });
});
