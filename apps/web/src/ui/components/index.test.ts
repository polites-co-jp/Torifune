import { describe, expect, it } from 'vitest';
import * as components from './index';
import type { ChartSeries } from './index';

/**
 * 共通部品の公開入口（028-analytics-dashboard-redesign 設計 §7.4、受け入れ条件 #98）。
 *
 * **Plugin は `index.ts` だけを見る**（06_画面設計.md §32）。個別ファイルに部品があっても
 * ここから出ていなければ Plugin からは使えない。
 *
 * `ChartSeries` は型なので実行時には検査できない。`import type` が通ること
 * （`pnpm typecheck`）で担保する。
 */

const exported = components as Record<string, unknown>;

describe('共通部品の公開入口', () => {
  it.each(['Switch', 'Badge', 'Stat', 'SegmentedControl', 'Meter', 'BarChart'])(
    '%s が index.ts から import できる',
    (name) => {
      expect(exported[name], `${name} が公開されていない`).toBeTypeOf('function');
    },
  );

  it('従来の部品も引き続き公開されている', () => {
    for (const name of [
      'Alert',
      'Button',
      'Card',
      'Checkbox',
      'Input',
      'Select',
      'Spinner',
      'Textarea',
      'FormField',
      'Pagination',
      'Table',
      'Tabs',
      'Chart',
      'DateField',
      'ConfirmDialog',
      'EmptyState',
      'Modal',
      'SecretField',
      'Toast',
    ]) {
      expect(exported[name], `${name} が公開から消えている`).toBeTypeOf('function');
    }
  });

  it('ChartSeries 型が index.ts から import できる（typecheck で担保）', () => {
    const sample: ChartSeries = {
      key: 'pageviews',
      label: 'ページビュー',
      points: [{ label: '2026-09-01', value: 1 }],
      tone: 'chart-1',
    };
    expect(sample.key).toBe('pageviews');
  });
});
