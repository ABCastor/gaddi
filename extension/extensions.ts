import type { ChromeParams, ExtensionInfo } from '../shared/protocol.ts';
import { extensionParams } from '../shared/protocol.ts';

function describe(info: chrome.management.ExtensionInfo): ExtensionInfo {
  return { id: info.id, name: info.name, version: info.version, enabled: info.enabled,
    installType: info.installType, mayDisable: info.mayDisable, mayEnable: info.mayEnable,
    type: info.type, self: info.id === chrome.runtime.id };
}

// Only native commands reach this module. Browser policy lives in the broker.
export async function manageExtensions(params: ChromeParams, check: () => void,
  selfReload: () => Promise<unknown>): Promise<unknown> {
  check();
  if (params.operation === 'get') {
    const id = params.extensionId === 'self' ? chrome.runtime.id : params.extensionId;
    if (typeof id !== 'string' || !/^[a-p]{32}$/.test(id)) throw new Error('invalid extension ID');
    const info = await chrome.management.get(id); check(); return describe(info);
  }
  const input = extensionParams(params);
  if (input.operation === 'install') throw new Error('unpacked install must be validated by the broker');
  if (input.operation === 'list') {
    const items = await chrome.management.getAll(); check();
    return { extensions: items.map(describe) };
  }
  const id = input.extensionId === 'self' ? chrome.runtime.id : input.extensionId;
  if (id === chrome.runtime.id && ['disable', 'uninstall'].includes(input.operation)) throw new Error('Gaddi cannot disable or uninstall itself');
  if (id === chrome.runtime.id && input.operation === 'reload') return selfReload();
  const info = await chrome.management.get(id); check();
  if (info.type !== 'extension') throw new Error('only extensions can be changed');
  if (input.operation === 'reload') {
    if (!info.enabled) throw new Error('extension is disabled; use enable explicitly');
    if (!info.mayDisable) throw new Error('Chrome policy prevents restarting this extension');
    await chrome.management.setEnabled(id, false);
    // Restore even if the request deadline elapses after disabling. No replay of input.
    try { await chrome.management.setEnabled(id, true); }
    catch {
      try { await chrome.management.setEnabled(id, true); }
      catch { throw new Error('extension restart could not re-enable it; open chrome://extensions to enable it'); }
    }
    check();
    return { extension: describe(await chrome.management.get(id)), reloaded: true,
      mode: 'restart', note: 'Restarts extension code; changed manifest permissions require Chrome Reload.' };
  }
  if (input.operation === 'uninstall') {
    if (!info.mayDisable) throw new Error('Chrome policy prevents removing this extension');
    // Chrome forces a confirmation dialog for removing another extension and
    // rejects it without a Chrome user gesture. Native Touch ID is not that gesture.
    return { status: 'needs_you', extensionId: id, uninstalled: false,
      reason: 'Chrome requires your Remove click and confirmation; Gaddi approval does not supply a Chrome user gesture.',
      steps: [`Open chrome://extensions/?id=${id}, click Remove on ${info.name}, then confirm.`, 'Run browser_extensions list to verify removal.'] };
  }
  const enabled = input.operation === 'enable';
  if (!enabled && !info.mayDisable || enabled && info.mayEnable === false) throw new Error('Chrome policy prevents this extension change');
  await chrome.management.setEnabled(id, enabled); check();
  return { extension: describe(await chrome.management.get(id)) };
}
