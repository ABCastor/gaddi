// Shared wire contracts. Parsed JSON stays unknown until a consumer checks its fields.
export type RequestId = string | number | null;
interface SignedProof { ts: number; sig: string }
export interface SelfHeal { at: number; reason: 'native-disconnect' | 'broker-unresponsive' | 'broker-requested'; action: 'reconnect' | 'reload' }
export interface ChromeParams {
  operation?: ExtensionOperation | 'get'; extensionId?: string;
  tab?: number; tabs?: number[]; url?: string; query?: string; group?: string;
  foreground?: boolean; selector?: string; text?: string; key?: string; mode?: 'replace' | 'append';
  expression?: string; dy?: number; fullPage?: boolean; width?: number; height?: number;
  mobile?: boolean; reset?: boolean; colorScheme?: 'light' | 'dark' | 'no-preference';
  animationSpeed?: number; value?: string; denySelectors?: string[];
  _description?: { name?: string; href?: string; submitName?: string };
  checkedDescription?: { name?: string; href?: string; submitName?: string };
  visible?: boolean; settleMs?: number; gone?: boolean; timeout?: number;
  version?: string;
  // Internal ownership of temporary rich-editor layout during trusted append.
  appendCleanup?: string;
  // Broker-only credential actions. Public type/press never forward this authority.
  signin?: { site: string; kind?: 'username' | 'password' | 'otp' };
  // A file the broker vetted, sent in base64 pieces and then attached by reference to them.
  upload?: { id: string; index?: number; data?: string; chunks?: number; name?: string; type?: string; lastModified?: number; size?: number; sha256?: string };
  file?: { name: string; type: string; lastModified: number; data: string };
}
export interface BrokerParams extends ChromeParams {
  lastSelfHeal?: unknown;
  caller?: string; session?: string; harness?: string; approval?: string; id?: string; proof?: SignedProof;
  kind?: string; n?: number; path?: string; item?: string;
  remember?: boolean; site?: string; reason?: string;
  // browser_grant: what to waive (`<upload|post|delete> <address prefix>`), for how long, and the agent's own words.
  rules?: string[]; minutes?: number; label?: string;
}
type ExtensionOperation = 'list' | 'reload' | 'enable' | 'disable' | 'uninstall' | 'install';
export interface ExtensionInfo {
  id: string; name: string; version: string; enabled: boolean; installType: string;
  mayDisable: boolean; mayEnable?: boolean; type: string; self: boolean;
}
export function extensionParams(params: { operation?: unknown; extensionId?: unknown; path?: unknown }) {
  const operation = params.operation ?? 'list';
  if (!['list', 'reload', 'enable', 'disable', 'uninstall', 'install'].includes(String(operation))) throw new Error('invalid extension operation');
  if (operation === 'install') {
    if (params.extensionId !== undefined || typeof params.path !== 'string' || !params.path.trim()) throw new Error('install requires a local folder path and no extensionId');
    return { operation: 'install' as const, path: params.path };
  }
  if (params.path !== undefined) throw new Error('path applies only to extension install');
  if (operation === 'list') {
    if (params.extensionId !== undefined) throw new Error('list does not take an extensionId');
    return { operation: 'list' as const };
  }
  if (typeof params.extensionId !== 'string' || !/^[a-p]{32}$/.test(params.extensionId) && params.extensionId !== 'self') throw new Error('extensionId must be self or a Chrome extension ID');
  return { operation: operation as Exclude<ExtensionOperation, 'list' | 'install'>, extensionId: params.extensionId };
}
export type IncomingParams = { [K in keyof BrokerParams]?: unknown };
export interface BrokerRequest { id: RequestId; method: string; params?: BrokerParams }
export interface ChromeRequest { id: string | number; method: string; params: ChromeParams; deadline?: number }
interface ApprovalRef { id: string; reason: string; expires: string }
export interface WireError { code?: string; message: string; approval?: ApprovalRef }
export interface Reply<T = unknown> { id: RequestId; result?: T; error?: WireError }
export interface TabInfo { id?: number; tabId?: number; tab?: number; url?: string; title?: string; active?: boolean; group?: string; groupId?: number; windowId?: number; index?: number; frozen?: boolean; discarded?: boolean }
export interface ElementDescription {
  name?: string; tag?: string; type?: string; autocomplete?: string;
  href?: string; submitName?: string; matched?: string[]; selector?: string;
}
// Results of the extension's serialized page function, keyed by the requested action.
export interface ImageBox { x: number; y: number; width: number; height: number }
export interface ApprovalCapture { data: string; mimeType: string; width: number; height: number; box: ImageBox }
export interface SigninProbe { url: string; signature: string; username?: string; password?: string; passwordPresent?: boolean; otp?: string; challenge?: boolean }
export interface SigninResult { outcome: 'signed_in' | 'needs_you' | 'no_login' | 'choose' | 'failed'; site: string; item_title?: string; step?: string; reason?: string }
export interface PageResults {
  signinProbe: SigninProbe;
  signinFocus: { signature: string; selector: string; combobox: false };
  signinCheck: PageResults['signinFocus'];
  signinLanded: { landed: boolean };
  signinSubmitFocus: PageResults['snapshot'];
  signinSubmitCheck: PageResults['snapshot'];
  wait: { met: boolean };
  captureBox: { box: ImageBox; clip: ImageBox; pixelRatio: number; selector: string; beyondViewport: boolean };
  animationSpeed: { animationSpeed: number | undefined };
  describe: Required<ElementDescription> & { role: string; password: boolean; disabled: boolean };
  read: { text: string; outline: string; version?: string; offscreen?: { above: number; below: number }; scroll: { y: number; height: number } };
  html: { html: string; truncated: boolean };
  evalCheck: Record<string, never>;
  snapshot: { signature: string };
  settle: PageResults['snapshot'] & { url: string; version?: string };
  pressCheck: PageResults['snapshot'];
  closeForeignFrames: { closed: number };
  scroll: PageResults['snapshot'] & { scrolled: boolean };
  select: PageResults['snapshot'] & { selected: boolean };
  typeFocus: PageResults['snapshot'] & { selector: string; combobox: boolean; expectedText?: string; appendNeedsEnd?: boolean; appendCleanup?: string };
  typeCheck: PageResults['typeFocus'];
  typeCleanup: Record<string, never>;
  typeLanded: { landed: boolean };
  clickPoint: PageResults['snapshot'] & { x: number; y: number };
  clickCheck: { x: number; y: number };
  upload: PageResults['snapshot'] & { via: 'input' | 'drop' };
  hoverPoint: PageResults['clickPoint'];
}
// The transport envelope may carry an error instead of the action's result.
export type PageResult = { __gaddiError?: string; __gaddiCode?: string } & Partial<PageResults['animationSpeed']
  & Omit<PageResults['describe'], 'password'> & PageResults['read'] & PageResults['html']
  & PageResults['wait'] & PageResults['captureBox'] & PageResults['scroll'] & PageResults['select'] & PageResults['clickPoint'] & PageResults['typeFocus'] & PageResults['settle']
  & PageResults['closeForeignFrames'] & PageResults['typeLanded'] & PageResults['upload'] & Omit<SigninProbe, 'password'> & { password: boolean | string }>;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function parseJSON(text: string): unknown { return JSON.parse(text) as unknown; }
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : isRecord(error) ? String(error.message) : String(error);
}
export function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
export function isTabInfo(value: unknown): value is TabInfo {
  return isRecord(value)
    && ['id', 'tabId', 'tab', 'groupId', 'windowId'].every(key => value[key] === undefined || typeof value[key] === 'number')
    && ['url', 'title', 'group'].every(key => value[key] === undefined || typeof value[key] === 'string')
    && (value.active === undefined || typeof value.active === 'boolean');
}

export interface HTMLPage { tab: number; url: string; html: string; truncated?: boolean }
export interface TextPage { tab: number; url: string; text: string; version?: string; note?: string; outline?: string; offscreen?: { above: number; below: number }; title?: unknown; untrusted?: boolean; length?: number; truncated?: boolean; scroll?: { y: number; height: number } }
interface InputResult { tab: number; url: string; changed: boolean; version?: string; navigating?: boolean; note?: string }
export interface CloseResult { closed: number[]; failed: { tab: number; reason: string }[] }
interface BookmarkInfo { path: string; title: string; url: string }
interface ScreenshotResult { path: string; mimeType: string; tab?: number; url?: string }
export interface BrokerResults {
  signin: SigninResult;
  tabs: { tabs: TabInfo[] };
  bookmarks: { bookmarks: BookmarkInfo[] };
  open: TabInfo;
  html: HTMLPage;
  look: TextPage;
  close: CloseResult;
  screenshot: ScreenshotResult;
  click: InputResult & { clicked: boolean };
  type: InputResult & { typed: boolean };
  press: InputResult & { pressed: boolean };
  select: InputResult & { selected: boolean };
  scroll: InputResult & { scrolled: boolean };
  hover: InputResult & { hovered: boolean };
  upload: InputResult & { uploaded: boolean; via: 'input' | 'drop' };
}
export type BrokerResult<M extends string> = M extends keyof BrokerResults ? BrokerResults[M] : unknown;
export type BrokerRPC = <M extends string>(method: M, params?: BrokerParams) => Promise<BrokerResult<M>>;

// Check only the result fields a client consumes; arbitrary eval and policy payloads stay opaque.
export function isBrokerResult<M extends string>(method: M, value: unknown): value is BrokerResult<M> {
  switch (method) {
    case 'signin': return isRecord(value) && ['signed_in', 'needs_you', 'no_login', 'choose', 'failed'].includes(String(value.outcome))
      && typeof value.site === 'string' && ['item_title', 'step', 'reason'].every(key => value[key] === undefined || typeof value[key] === 'string')
      && Object.keys(value).every(key => ['outcome', 'site', 'item_title', 'step', 'reason'].includes(key));
    case 'tabs': return isRecord(value) && Array.isArray(value.tabs) && value.tabs.every(isTabInfo);
    case 'bookmarks': return isRecord(value) && Array.isArray(value.bookmarks) && value.bookmarks.every(item =>
      isRecord(item) && ['path', 'title', 'url'].every(key => typeof item[key] === 'string'));
    case 'open': return isTabInfo(value);
    case 'html': return isRecord(value) && typeof value.tab === 'number' && typeof value.url === 'string' && typeof value.html === 'string'
      && (value.truncated === undefined || typeof value.truncated === 'boolean');
    case 'look': return isRecord(value) && typeof value.tab === 'number' && typeof value.url === 'string' && typeof value.text === 'string'
      && ['note', 'outline', 'version'].every(key => value[key] === undefined || typeof value[key] === 'string')
      && ['untrusted', 'truncated'].every(key => value[key] === undefined || typeof value[key] === 'boolean')
      && (value.scroll === undefined || isRecord(value.scroll) && typeof value.scroll.y === 'number' && typeof value.scroll.height === 'number')
      && (value.length === undefined || typeof value.length === 'number');
    case 'close': return isRecord(value) && Array.isArray(value.closed) && value.closed.every(id => typeof id === 'number')
      && Array.isArray(value.failed) && value.failed.every(item => isRecord(item) && typeof item.tab === 'number' && typeof item.reason === 'string');
    case 'screenshot': return isRecord(value) && typeof value.path === 'string' && typeof value.mimeType === 'string'
      && (value.tab === undefined || typeof value.tab === 'number') && (value.url === undefined || typeof value.url === 'string');
    default: return true;
  }
}

export function versionParam(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw new Error('version must be a short opaque string');
  return value;
}

// Shared by broker and extension, including clients that bypass MCP schemas.
export function waitParams(params: { text?: unknown; selector?: unknown; url?: unknown; gone?: unknown; timeout?: unknown }): ChromeParams {
  const keys = (['text', 'selector', 'url'] as const).filter(key => params[key] !== undefined);
  if (keys.length !== 1) throw new Error('wait requires exactly one of text, selector or url');
  const key = keys[0], value = params[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`wait ${key} must be a nonempty string`);
  if (params.gone !== undefined && typeof params.gone !== 'boolean') throw new Error('gone must be boolean');
  if (key === 'url' && params.gone === true) throw new Error('gone applies only to text or selector');
  const timeout = params.timeout ?? 10000;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0 || timeout > 20000) throw new Error('timeout must be between 0 and 20000 ms');
  return { [key]: value, timeout, ...(params.gone !== undefined ? { gone: params.gone } : {}) };
}
