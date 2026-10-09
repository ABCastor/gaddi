import type { ElementDescription, TabInfo, ChromeParams, ScrollOffset } from '../../shared/protocol.ts';
import { isRecord } from '../../shared/protocol.ts';
import assert from 'node:assert/strict';
import type { FakeDaemon } from './fake-daemon.ts';

export interface FixtureTab extends TabInfo {
  id: number; windowId: number; index: number; active: boolean; title: string; url: string;
  frozen?: boolean; discarded?: boolean;
}
export interface ChromeResults {
  'chrome.tabs': { tabs: FixtureTab[] };
  'chrome.active': FixtureTab;
  'chrome.open': FixtureTab;
  'chrome.goto': FixtureTab;
  'chrome.back': FixtureTab;
  'chrome.show': FixtureTab;
  'chrome.group': { tabs: FixtureTab[]; group: string; groupId: number };
  'chrome.close': { closed: number[]; failed: { tab: number; reason: string }[] };
  'chrome.bookmarks': { bookmarks: { path: string; title: string; url: string }[] };
  'chrome.describe': Required<ElementDescription> & { role: string; password: boolean; disabled: boolean };
  'chrome.read': { tab: number; url: string; text: string; outline: string; version?: string; scroll: { y: number; height: number }; note?: string };
  'chrome.html': { html: string; truncated: boolean };
  'chrome.screenshot': { data: string; mimeType: string };
  'chrome.eval': { value: unknown };
  'chrome.emulate': { emulated: boolean };
  'chrome.click': { clicked: boolean; changed: boolean; url: string; navigating?: boolean; version?: string; note?: string };
  'chrome.hover': { hovered: boolean; changed: boolean; url: string; navigating?: boolean; version?: string; note?: string };
  'chrome.type': { typed: boolean; changed: boolean; url: string; navigating?: boolean; version?: string; note?: string };
  'chrome.press': { pressed: boolean; changed: boolean; url: string; navigating?: boolean; version?: string; note?: string };
  'chrome.scroll': { scrolled: boolean; changed: boolean; url: string; navigating?: boolean; version?: string; note?: string;
    position?: { before: ScrollOffset; after: ScrollOffset } };
  'chrome.select': { selected: boolean; changed: boolean; url: string; navigating?: boolean; version?: string; note?: string };
}
// Decode native replies at the test transport boundary before exposing typed results.
const hasFields = (value: Record<string, unknown>, fields: Record<string, string>) =>
  Object.entries(fields).every(([key, type]) => typeof value[key] === type);
export function isFixtureTab(value: unknown): value is FixtureTab {
  return isRecord(value) && hasFields(value, { id: 'number', windowId: 'number', index: 'number', active: 'boolean', title: 'string', url: 'string' });
}
export function isChromeResult<M extends keyof ChromeResults>(method: M, value: unknown): value is ChromeResults[M] {
  if (!isRecord(value)) return false;
  switch (method) {
    case 'chrome.active': case 'chrome.open': case 'chrome.goto': case 'chrome.back': case 'chrome.show': return isFixtureTab(value);
    case 'chrome.tabs': return Array.isArray(value.tabs) && value.tabs.every(isFixtureTab);
    case 'chrome.group': return typeof value.group === 'string' && typeof value.groupId === 'number'
      && Array.isArray(value.tabs) && value.tabs.every(isFixtureTab);
    case 'chrome.close': return Array.isArray(value.closed) && value.closed.every(id => typeof id === 'number')
      && Array.isArray(value.failed) && value.failed.every(item => isRecord(item) && hasFields(item, { tab: 'number', reason: 'string' }));
    case 'chrome.bookmarks': return Array.isArray(value.bookmarks) && value.bookmarks.every(item => isRecord(item) && hasFields(item, { path: 'string', title: 'string', url: 'string' }));
    case 'chrome.describe': return hasFields(value, { selector: 'string', name: 'string', tag: 'string', type: 'string', autocomplete: 'string', href: 'string', submitName: 'string', role: 'string', password: 'boolean', disabled: 'boolean' })
      && Array.isArray(value.matched) && value.matched.every(item => typeof item === 'string');
    case 'chrome.read': return hasFields(value, { tab: 'number', url: 'string', text: 'string', outline: 'string' })
      && isRecord(value.scroll) && hasFields(value.scroll, { y: 'number', height: 'number' });
    case 'chrome.html': return hasFields(value, { html: 'string', truncated: 'boolean' });
    case 'chrome.screenshot': return hasFields(value, { data: 'string', mimeType: 'string' });
    case 'chrome.eval': return 'value' in value;
    default: {
      const fields = { 'chrome.emulate': 'emulated', 'chrome.click': 'clicked', 'chrome.hover': 'hovered', 'chrome.type': 'typed', 'chrome.press': 'pressed', 'chrome.scroll': 'scrolled', 'chrome.select': 'selected' };
      const offset = (v: unknown) => isRecord(v) && hasFields(v, { left: 'number', top: 'number' });
      return method in fields && typeof value[fields[method as keyof typeof fields]] === 'boolean'
        && (method === 'chrome.emulate' || typeof value.changed === 'boolean' && typeof value.url === 'string'
          && (value.navigating === undefined || typeof value.navigating === 'boolean'))
        && (value.position === undefined || isRecord(value.position) && offset(value.position.before) && offset(value.position.after));
    }
  }
}
export function callsFor(daemon: FakeDaemon) {
  return async <M extends keyof ChromeResults>(method: M, params: ChromeParams = {}): Promise<ChromeResults[M]> => {
    const result = await daemon.call(method, params);
    assert.ok(isChromeResult(method, result), `Invalid ${method} fixture reply`);
    return result;
  };
}
