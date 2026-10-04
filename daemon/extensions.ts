import { extensionParams, isRecord } from '../shared/protocol.ts';
import type { ChromeParams, IncomingParams, ExtensionInfo } from '../shared/protocol.ts';
import type { ApprovalAction } from './approvals.ts';
import { GateError } from './approvals.ts';
import { checkExtension } from './policy.ts';
import type { Policy, PolicyCheck } from './policy.ts';
import { validateUnpackedExtension, installUnpackedExtension } from './extensions-install.ts';

export function extensionInfo(value: unknown): ExtensionInfo {
  if (!isRecord(value) || !/^[a-p]{32}$/.test(String(value.id))
    || !['name', 'version', 'installType', 'type'].every(k => typeof value[k] === 'string')
    || !['enabled', 'mayDisable', 'self'].every(k => typeof value[k] === 'boolean')
    || value.mayEnable !== undefined && typeof value.mayEnable !== 'boolean') throw new Error('invalid extension metadata from Chrome');
  return { id: String(value.id), name: String(value.name), version: String(value.version),
    installType: String(value.installType), type: String(value.type), enabled: value.enabled as boolean,
    mayDisable: value.mayDisable as boolean, self: value.self as boolean,
    ...(value.mayEnable === undefined ? {} : { mayEnable: value.mayEnable as boolean }) };
}

interface ExtensionGate {
  kind: string; meta: { caller: string; tab: null; url: string }; detail: string;
  action: ApprovalAction; check: PolicyCheck; approval: unknown;
}
export async function extensionCall(params: IncomingParams, caller: string, policy: Policy,
  request: (params: ChromeParams) => Promise<unknown>, gate: (options: ExtensionGate) => Promise<unknown>) {
  const input = extensionParams(params), meta = { caller, tab: null, url: 'chrome://extensions/' };
  if (input.operation === 'install') {
    const source = await validateUnpackedExtension(input.path);
    const action = { method: 'extensions', caller, url: meta.url, operation: 'install', path: source.path, fingerprint: source.fingerprint };
    await gate({ kind: 'extension.install', meta, detail: `${source.name} (${source.version}) from ${source.path}`, action,
      check: checkExtension(policy, 'install', source.trusted), approval: params.approval });
    // A signed decision cannot authorize code changed while the owner reviewed it.
    const current = await validateUnpackedExtension(source.path);
    if (current.fingerprint !== source.fingerprint) throw new GateError('approval-invalid', 'extension folder changed; request installation again');
    return installUnpackedExtension(current);
  }
  if (input.operation === 'list') {
    if (params.approval !== undefined) throw new Error('list does not consume an approval');
    const result = await request(input);
    if (!isRecord(result) || !Array.isArray(result.extensions)) throw new Error('invalid extension list from Chrome');
    return { extensions: result.extensions.map(extensionInfo) };
  }
  const before = extensionInfo(await request({ operation: 'get', extensionId: input.extensionId }));
  if (input.extensionId !== 'self' && before.id !== input.extensionId || input.extensionId === 'self' && !before.self) throw new Error('Chrome extension identity mismatch');
  if (before.self && ['disable', 'uninstall'].includes(input.operation)) throw new GateError('denied', 'Gaddi cannot disable or uninstall itself');
  if (before.type !== 'extension') throw new GateError('denied', 'only Chrome extensions can be changed');
  const action = { method: 'extensions', caller, url: meta.url, operation: input.operation, extension: before };
  await gate({ kind: 'extension.' + input.operation, meta, detail: `${before.name} (${before.version}, ${before.id})`, action,
    check: checkExtension(policy, input.operation), approval: params.approval });
  // Recheck after gating. A replaced extension cannot inherit another's decision.
  const current = extensionInfo(await request({ operation: 'get', extensionId: before.id }));
  if (JSON.stringify(current) !== JSON.stringify(before)) throw new GateError('approval-invalid', 'extension changed; request the action again');
  return request({ ...input, extensionId: before.id });
}
