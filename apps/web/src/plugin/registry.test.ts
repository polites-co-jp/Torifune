import type { Plugin, PluginManifest } from '@torifune/plugin-api';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectActions,
  collectExtensions,
  collectMenus,
  collectWidgets,
  definedExtensionPoints,
  findPage,
  isLoaded,
  loadedPlugin,
  loadedPlugins,
  registerLoadedPlugin,
  registrationsOf,
  resetPluginRegistry,
  unregisterPlugin,
} from './registry';

const noop: Plugin = { activate: () => undefined };

function manifest(id: string): PluginManifest {
  return { id, name: id, version: '1.0.0', apiVersion: 1 };
}

function load(id: string): ReturnType<typeof registrationsOf> {
  registerLoadedPlugin({ manifest: manifest(id), plugin: noop });
  return registrationsOf(id);
}

afterEach(() => {
  resetPluginRegistry();
});

describe('読み込み', () => {
  it('読み込んだ Plugin を引ける', () => {
    load('a-plugin');

    expect(isLoaded('a-plugin')).toBe(true);
    expect(loadedPlugin('a-plugin')?.manifest.id).toBe('a-plugin');
    expect(loadedPlugins()).toHaveLength(1);
  });

  it('読み込んでいない Plugin は null', () => {
    expect(loadedPlugin('missing')).toBeNull();
    expect(isLoaded('missing')).toBe(false);
  });
});

describe('登録の取り消し', () => {
  it('他の Plugin の登録を巻き込まない', () => {
    // 巻き込むと、1つを無効化しただけで無関係な画面が消える。
    load('a-plugin').menus.push({ label: 'A', route: '/plugins/a-plugin' });
    load('b-plugin').menus.push({ label: 'B', route: '/plugins/b-plugin' });

    unregisterPlugin('a-plugin');

    expect(collectMenus(new Set()).map((m) => m.label)).toEqual(['B']);
    expect(isLoaded('b-plugin')).toBe(true);
  });

  it('購読の解除関数を返す', () => {
    let unsubscribed = false;
    const registrations = load('a-plugin');
    registrations.unsubscribers.push(() => {
      unsubscribed = true;
    });

    unregisterPlugin('a-plugin');

    expect(unsubscribed).toBe(true);
  });

  it('解除関数が例外を投げても残りを解除する', () => {
    // 1つの後始末の失敗で、他の購読が残り続けるのは困る。
    let second = false;
    const registrations = load('a-plugin');
    registrations.unsubscribers.push(() => {
      throw new Error('解除に失敗');
    });
    registrations.unsubscribers.push(() => {
      second = true;
    });

    unregisterPlugin('a-plugin');

    expect(second).toBe(true);
  });

  it('読み込んでいない Plugin を取り消しても壊れない', () => {
    expect(() => unregisterPlugin('missing')).not.toThrow();
  });
});

describe('収集', () => {
  it('Widget を置き場所で絞る', () => {
    const registrations = load('a-plugin');
    registrations.widgets.push({ location: 'dashboard', component: () => null });
    registrations.widgets.push({ location: 'site.detail', component: () => null });

    expect(collectWidgets('dashboard', new Set())).toHaveLength(1);
    expect(collectWidgets('site.detail', new Set())).toHaveLength(1);
    expect(collectWidgets('nowhere', new Set())).toHaveLength(0);
  });

  it('Action を Permission で絞る', () => {
    const registrations = load('a-plugin');
    registrations.actions.push({
      location: 'site.list.actions',
      label: '同期',
      component: () => null,
      permission: 'site.write',
    });

    expect(collectActions('site.list.actions', new Set())).toHaveLength(0);
    expect(collectActions('site.list.actions', new Set(['site.write']))).toHaveLength(1);
  });

  it('収集したものに、どの Plugin のものかが付く', () => {
    // 描画側が Plugin ごとの Data API を組み立てるために要る。
    load('a-plugin').widgets.push({ location: 'dashboard', component: () => null });

    expect(collectWidgets('dashboard', new Set())[0]?.pluginId).toBe('a-plugin');
  });

  it('拡張点は複数の Plugin から差し込める', () => {
    load('a-plugin').extensions.push({
      point: 'site.edit.sidebar',
      component: () => null,
      order: 20,
    });
    load('b-plugin').extensions.push({
      point: 'site.edit.sidebar',
      component: () => null,
      order: 10,
    });

    expect(collectExtensions('site.edit.sidebar', new Set())).toHaveLength(2);
    expect(collectExtensions('site.edit.sidebar', new Set())[0]?.registration.order).toBe(10);
  });

  it('Plugin が定義した拡張点を一覧できる', () => {
    load('a-plugin').definedPoints.add('a-plugin.report.footer');
    load('b-plugin').definedPoints.add('b-plugin.chart.header');

    expect(definedExtensionPoints()).toEqual(['a-plugin.report.footer', 'b-plugin.chart.header']);
  });
});

describe('ページの解決', () => {
  it('完全一致を前方一致より優先する', () => {
    const registrations = load('a-plugin');
    registrations.pages.push({ route: '/plugins/a-plugin', component: () => null, title: '一覧' });
    registrations.pages.push({
      route: '/plugins/a-plugin/reports',
      component: () => null,
      title: '詳細',
    });

    expect(findPage('a-plugin', '/plugins/a-plugin/reports')?.title).toBe('詳細');
  });

  it('前方一致は最も長いものを選ぶ', () => {
    const registrations = load('a-plugin');
    registrations.pages.push({ route: '/plugins/a-plugin', component: () => null, title: '浅い' });
    registrations.pages.push({
      route: '/plugins/a-plugin/reports',
      component: () => null,
      title: '深い',
    });

    expect(findPage('a-plugin', '/plugins/a-plugin/reports/1')?.title).toBe('深い');
  });

  it('別の Plugin のページは引けない', () => {
    // 引けると、Plugin ID を差し替えるだけで他の Plugin の画面へ入れる。
    load('a-plugin').pages.push({ route: '/plugins/a-plugin', component: () => null });
    load('b-plugin');

    expect(findPage('b-plugin', '/plugins/a-plugin')).toBeNull();
  });
});

describe('全消し', () => {
  it('resetPluginRegistry ですべて消える', () => {
    load('a-plugin').menus.push({ label: 'A', route: '/plugins/a-plugin' });

    resetPluginRegistry();

    expect(loadedPlugins()).toEqual([]);
    expect(collectMenus(new Set())).toEqual([]);
  });
});
