import assert from 'node:assert/strict';
import { isRecord, isBrokerResult, isTabInfo, parseJSON } from '../../shared/protocol.ts';
import type { BrokerResult, BrokerResults, Reply, TabInfo, ChromeRequest } from '../../shared/protocol.ts';
import type { ApprovalRecord } from '../../daemon/approvals.ts';
export type PublicApproval = Omit<ApprovalRecord, 'actionHash'>;
export interface AuditEntry { method: string; outcome: string; caller: string; tab: number | null; url: string; changed?: boolean; tabs?: { tab: number; url: string }[] }
interface ExtraResults {
  'approvals.list': { pending: PublicApproval[]; recent: PublicApproval[] };
  approvals: { pending: PublicApproval[]; recent: PublicApproval[] };
  'audit.tail': { entries: AuditEntry[] };
  'bridge.status': { connected: boolean };
  status: { version: number };
  eval: { value: unknown };
  scroll: { ok: boolean };
  emulate: { ok: boolean };
  show: TabInfo;
  group: { tabs: TabInfo[]; group: string };
}
export type TestResult<M extends string> = M extends keyof ExtraResults ? ExtraResults[M] : BrokerResult<M>;
export function isApproval(a: unknown): a is PublicApproval {
 return isRecord(a) && ['id','kind','caller','url','detail','reason','status','createdAt','expiresAt'].every(k => typeof a[k] === 'string')
  && (a.tab === null || typeof a.tab === 'number') && ['resolvedAt','by','usedAt','imagePath','targetSelector'].every(k => a[k] === undefined || typeof a[k] === 'string')
  && (a.box === undefined || isRecord(a.box) && ['x','y','width','height'].every(k => isRecord(a.box) && typeof a.box[k] === 'number' && Number.isFinite(a.box[k])));
}
function isAudit(a: unknown): a is AuditEntry {
 return isRecord(a) && ['method','outcome','caller','url'].every(k => typeof a[k] === 'string')
  && (a.tab === null || typeof a.tab === 'number')
  && (a.changed === undefined || typeof a.changed === 'boolean')
  && (a.tabs === undefined || Array.isArray(a.tabs) && a.tabs.every(t => isRecord(t) && typeof t.tab === 'number' && typeof t.url === 'string'));
}
function isTestResult<M extends string>(method: M, value: unknown): value is TestResult<M> {
 switch (method) {
  case 'approvals.list': case 'approvals': return isRecord(value) && Array.isArray(value.pending) && value.pending.every(isApproval) && Array.isArray(value.recent) && value.recent.every(isApproval);
  case 'audit.tail': return isRecord(value) && Array.isArray(value.entries) && value.entries.every(isAudit);
  case 'bridge.status': return isRecord(value) && typeof value.connected === 'boolean';
  case 'status': return isRecord(value) && typeof value.version === 'number';
  case 'eval': return isRecord(value) && Object.hasOwn(value, 'value');
  case 'scroll': case 'emulate': return isRecord(value) && typeof value.ok === 'boolean';
  case 'show': return isTabInfo(value);
  case 'group': return isRecord(value) && typeof value.group === 'string' && Array.isArray(value.tabs) && value.tabs.every(isTabInfo);
  default: return isBrokerResult(method, value);
 }
}
export function checkedResult<M extends string>(method: M, value: unknown): TestResult<M> {
 assert.ok(isTestResult(method, value), `invalid ${method} result: ${JSON.stringify(value)}`); return value;
}
export function checkedReply(value: unknown): Reply {
 assert.ok(isRecord(value));
 // The CLI prints a bare result object; socket replies always carry an id.
 const id = value.id === undefined ? null : value.id;
 assert.ok(id === null || typeof id === 'string' || typeof id === 'number');
 const reply: Reply = { id, ...(Object.hasOwn(value, 'result') ? { result: value.result } : {}) };
 if (value.error !== undefined) {
  assert.ok(isRecord(value.error)); const error = value.error;
  assert.equal(typeof error.message, 'string'); assert.ok(typeof error.message === 'string');
  assert.ok(error.code === undefined || typeof error.code === 'string');
  reply.error = { message: error.message, code: error.code };
  if (error.approval !== undefined) {
   assert.ok(isRecord(error.approval)); const a = error.approval;
   assert.ok(typeof a.id === 'string' && typeof a.reason === 'string' && typeof a.expires === 'string');
   reply.error.approval = { id: a.id, reason: a.reason, expires: a.expires };
  }
 }
 return reply;
}
export function checkedRequest(value: unknown): ChromeRequest {
 assert.ok(isRecord(value));
 assert.ok(typeof value.id === 'string' || typeof value.id === 'number');
 assert.ok(typeof value.method === 'string');
 const params = value.params;
 assert.ok(isRecord(params));
 assert.ok(value.deadline === undefined || typeof value.deadline === 'number' && Number.isFinite(value.deadline));
 // Check every transmitted fixture parameter against the concrete shared contract.
 assert.ok(['url','query','group','selector','text','key','expression','value'].every(k => params[k] === undefined || typeof params[k] === 'string'));
 assert.ok(['tab','dy','width','height','animationSpeed'].every(k => params[k] === undefined || typeof params[k] === 'number'));
 assert.ok(['foreground','fullPage','mobile','reset'].every(k => params[k] === undefined || typeof params[k] === 'boolean'));
 assert.ok(params.tabs === undefined || Array.isArray(params.tabs) && params.tabs.every(v => typeof v === 'number'));
 assert.ok(params.upload === undefined || isRecord(params.upload) && typeof params.upload.id === 'string');
 assert.ok(params.denySelectors === undefined || Array.isArray(params.denySelectors) && params.denySelectors.every(v => typeof v === 'string'));
 assert.ok(params.colorScheme === undefined || ['light','dark','no-preference'].includes(String(params.colorScheme)));
 assert.ok(params._description === undefined || isRecord(params._description) && ['name','href','submitName'].every(k => !isRecord(params._description) || params._description[k] === undefined || typeof params._description[k] === 'string'));
 assert.ok(params.checkedDescription === undefined || isRecord(params.checkedDescription) && ['name','href','submitName'].every(k => !isRecord(params.checkedDescription) || params.checkedDescription[k] === undefined || typeof params.checkedDescription[k] === 'string'));
 return { id: value.id, method: value.method, params: params as ChromeRequest['params'],
   ...(typeof value.deadline === 'number' ? { deadline: value.deadline } : {}) };
}
export { parseJSON, isRecord };
