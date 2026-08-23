import { describe, expect, it } from 'vitest';
import { PLUGIN_API_VERSION } from './index.js';

describe('PLUGIN_API_VERSION', () => {
  it('は 1 である', () => {
    expect(PLUGIN_API_VERSION).toBe(1);
  });
});
