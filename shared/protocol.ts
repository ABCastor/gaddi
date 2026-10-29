// Shared wire contracts. Parsed JSON stays unknown until a consumer checks its fields.
export type RequestId = string | number | null;
interface SignedProof { ts: number; sig: string }
export interface SelfHeal { at: number; reason: 'native-disconnect' | 'broker-unresponsive' | 'broker-requested'; action: 'reconnect' | 'reload' }
export interface ChromeParams {
  browser?: { window: 'own' | 'shared'; show: 'attention' | 'front' };
  cleanup?: 'close'; // Internal idle maintenance, never forwarded from caller params.
  operation?: ExtensionOperation | 'get'; extensionId?: string;
  tab?: number; tabs?: number[]; url?: string; query?: string; group?: string;
  foreground?: boolean; selector?: string; text?: string; key?: string; mode?: 'replace' | 'append';
  expression?: string; dx?: number; dy?: number; fullPage?: boolean; width?: number; height?: number;
  mobile?: boolean; reset?: boolean; colorScheme?: 'light' | 'dark' | 'no-preference';
  animationSpeed?: number; value?: string; denySelectors?: string[];
  _description?: { name?: string; href?: string; submitName?: string };
  checkedDescription?: { name?: string; href?: string; submitName?: string };
  visible?: boolean; settleMs?: number; gone?: boolean; timeout?: number;
  // A point in the tab's own viewport, as a screenshot shows it: the place a person
  // would click. Used where a selector cannot be trusted to land (a banner over the
  // middle) or cannot be written (inside another origin's page). It is never translated
  // into a frame's coordinates; the extension resolves which document it falls in.
  at?: { x: number; y: number };
  // A region of an embedded document to see close up, in that document's own pixels: the answer to
  // a picture a model cannot read at the size it is drawn.
  zoom?: { x: number; y: number; width: number; height: number };
  // The document inside a tab to act on: 0 is the tab itself, any other id comes from
  // `look`, which lists every document the extension can reach.
  frameId?: number;
  version?: string;
  // Internal ownership of temporary rich-editor layout during trusted append.
  appendCleanup?: string;
  // Broker-only credential actions. Public type/press never forward this authority.
  signin?: { site: string; signup?: boolean; kind?: 'username' | 'password' | 'confirmation' | 'otp' };
  // Internal, origin-bound interception of a page's generated download. No local path crosses this wire.
  downloadCapture?: { id: string; site: string; index?: number };
  // A file the broker vetted, sent in base64 pieces and then attached by reference to them.
  upload?: { id: string; index?: number; data?: string; chunks?: number; name?: string; type?: string; lastModified?: number; size?: number; sha256?: string };
  file?: { name: string; type: string; lastModified: number; data: string };
}
export interface BrokerParams extends ChromeParams {
  lastSelfHeal?: unknown;
  caller?: string; session?: string; harness?: string; approval?: string; id?: string; proof?: SignedProof;
  kind?: string; n?: number; path?: string; item?: string;
  signup?: boolean; create?: { title: string; username: string; vault: string };
  download?: string;
  remember?: boolean; site?: string; reason?: string;
  // browser_grant: what to waive (`<upload|post|delete> <address prefix>`), for how long, and the agent's own words.
  rules?: string[]; minutes?: number; label?: string;
  // Shown to the owner if the call is held, never acted on: the agent's one-line purpose, and its chat and project
  // as the harness names them (daemon/approvals.ts ApprovalContext).
  why?: string; context?: { chat?: string; project?: string };
  // Approving from another device (the owner's phone approver; no MCP tool ever sends these): `fingerprint` names
  // the key that Touch ID turns on, and one decision is `{ id, verb, nonce, ts, sig }`.
  fingerprint?: string; verb?: string; nonce?: string; ts?: number; sig?: string;
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
  // True when the click toggles a choice (a checkbox, a radio, an option, or the label of
  // one) instead of performing an action. A choice's words describe what is being chosen,
  // so a gate must not read an action verb out of that prose (policy.ts:checkClick).
  choice?: boolean;
}
// What a point lands on, measured inside one document. `frame`/`x`/`y`/`width`/`height`
// describe an embedded document's content box, which is how the point is followed into it.
export interface PointTarget {
  selector: string; name: string; tag: string; role: string; choice: boolean; href: string;
  type: string; autocomplete: string; submitName: string; secret: boolean; disabled: boolean;
  signature: string;
  // The point's element and its ancestors, as document references: a caller can tell whether the
  // point is the control it measured or sits inside it (an icon inside a button).
  chain: string[];
  frame: boolean; frameUrl: string; x: number; y: number; width: number; height: number;
}
// Results of the extension's serialized page function, keyed by the requested action.
// A document listed by `look`, so an agent can act inside it by name. `challenge` marks a
// human-verification widget's own frame: never a hint to solve it, only the place to press
// as a person would, or the moment to hand the page back to the owner.
export interface FrameInfo { frameId: number; url: string; challenge?: boolean }
export interface ScrollOffset { left: number; top: number }
export interface ImageBox { x: number; y: number; width: number; height: number }
export interface ApprovalCapture { data: string; mimeType: string; width: number; height: number; box: ImageBox }
export interface SigninProbe { url: string; signature: string; username?: string; password?: string; confirmation?: string; passwordPresent?: boolean; otp?: string; challenge?: boolean }
export interface SigninResult { outcome: 'signed_in' | 'filled' | 'needs_you' | 'no_login' | 'choose' | 'failed'; site: string; item_title?: string; step?: string; reason?: string }
export interface PageResults {
  downloadArm: { armed: boolean };
  downloadPoll: { ready: boolean; bytes?: number; chunks?: number; error?: string };
  downloadChunk: { data: string };
  downloadEnd: { ended: boolean };
  signinProbe: SigninProbe;
  signinFocus: { signature: string; selector: string; combobox: false };
  signinCheck: PageResults['signinFocus'];
  signinLanded: { landed: boolean };
  signinSubmitFocus: PageResults['snapshot'];
  signinSubmitCheck: PageResults['snapshot'];
  wait: { met: boolean };
  captureBox: { box: ImageBox; clip: ImageBox; pixelRatio: number; selector: string; beyondViewport: boolean };
  animationSpeed: { animationSpeed: number | undefined };
  describe: Required<ElementDescription> & { role: string; password: boolean; disabled: boolean;
    frameId?: number; frameUrl?: string; blind?: boolean };
  // What a point lands on inside one document: the gate's facts, plus the embedded
  // document's content box when the point falls on a frame (bg.ts follows it inwards).
  pointTarget: PointTarget;
  read: { text: string; outline: string; version?: string; offscreen?: { above: number; below: number }; scroll: { y: number; height: number }; frames?: FrameInfo[] };
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
  // The point a trusted click would use and the document reference it was measured from, so a
  // frame-targeted click can prove the composed point still holds that very element.
  clickPoint: PageResults['snapshot'] & { x: number; y: number; selector: string };
  // Whether the tab's own document handed the focus to an embedded one.
  pressFocus: { embedded: boolean };
  // The visible part of a document, in CSS pixels.
  viewport: { width: number; height: number };
  // The scroller is a page reference to the nearest element that can take the wheel on the requested axis.
  scrollPoint: PageResults['snapshot'] & { x: number; y: number; selector: string; scroller: string } & ScrollOffset;
  scrollPosition: ScrollOffset;
  clickCheck: { x: number; y: number };
  upload: PageResults['snapshot'] & { via: 'input' | 'drop' };
  hoverPoint: PageResults['clickPoint'];
}
// The transport envelope may carry an error instead of the action's result.
export type PageResult = { __gaddiError?: string; __gaddiCode?: string } & Partial<PageResults['animationSpeed'] & PageResults['downloadArm'] & PageResults['downloadPoll'] & PageResults['downloadChunk'] & PageResults['downloadEnd']
  & Omit<PageResults['describe'], 'password'> & PageResults['read'] & PageResults['html']
  & PageResults['wait'] & PageResults['captureBox'] & PageResults['scroll'] & PageResults['select'] & PageResults['clickPoint'] & PageResults['scrollPoint'] & PageResults['typeFocus'] & PageResults['settle']
  & PageResults['closeForeignFrames'] & PageResults['typeLanded'] & PageResults['upload'] & PageResults['pointTarget'] & PageResults['pressFocus'] & PageResults['viewport']
  & Omit<SigninProbe, 'password'> & { password: boolean | string }>;
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
export interface TextPage { tab: number; url: string; text: string; version?: string; note?: string; outline?: string; offscreen?: { above: number; below: number }; title?: unknown; untrusted?: boolean; length?: number; truncated?: boolean; scroll?: { y: number; height: number }; frames?: FrameInfo[] }
// Where a click by point landed and what the gates judge: the deepest element under the
// point, and the embedded document holding it when there is one.
export interface PointDescription extends Required<ElementDescription> {
  role: string; password: boolean; disabled: boolean; frameId?: number; frameUrl?: string; blind?: boolean;
}
interface InputResult { tab: number; url: string; changed: boolean; version?: string; navigating?: boolean; note?: string }
export interface CloseResult { closed: number[]; failed: { tab: number; reason: string }[] }
interface BookmarkInfo { path: string; title: string; url: string }
// A crop of one document, and where that crop sits in the tab. A pixel (px, py) in an image of
// width x height is the tab point box.x + px * box.width / width, box.y + py * box.height / height,
// which is what `click` takes: a challenge picture can be read and answered, never guessed.
interface ScreenshotResult { path: string; mimeType: string; tab?: number; url?: string;
  width?: number; height?: number; box?: { x: number; y: number; width: number; height: number };
  frame?: { frameId: number; url: string } }
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
  scroll: InputResult & { scrolled: boolean; position?: { before: ScrollOffset; after: ScrollOffset } };
  hover: InputResult & { hovered: boolean };
  upload: InputResult & { uploaded: boolean; via: 'input' | 'drop' };
}
export type BrokerResult<M extends string> = M extends keyof BrokerResults ? BrokerResults[M] : unknown;
export type BrokerRPC = <M extends string>(method: M, params?: BrokerParams) => Promise<BrokerResult<M>>;

// Check only the result fields a client consumes; arbitrary eval and policy payloads stay opaque.
export function isBrokerResult<M extends string>(method: M, value: unknown): value is BrokerResult<M> {
  switch (method) {
    case 'signin': return isRecord(value) && ['signed_in', 'filled', 'needs_you', 'no_login', 'choose', 'failed'].includes(String(value.outcome))
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
// A viewport point, in CSS pixels: the place an owner would click. Bounded so a
// caller cannot name a point no viewport has.
export const POINT_LIMIT = 100000;
export function pointParam(value: unknown): { x: number; y: number } {
  if (!isRecord(value) || typeof value.x !== 'number' || typeof value.y !== 'number'
    || !Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x < 0 || value.y < 0
    || value.x > POINT_LIMIT || value.y > POINT_LIMIT) throw new Error('at must be { x, y } in viewport pixels');
  return { x: value.x, y: value.y };
}

// Wheel distances in CSS pixels. Shared by broker and extension, including clients that bypass MCP schemas.
export const WHEEL_LIMIT = 100000;
export function wheelParams(params: { dx?: unknown; dy?: unknown }): { dx?: number; dy?: number } {
  const wheel: { dx?: number; dy?: number } = {};
  for (const key of ['dx', 'dy'] as const) {
    const value = params[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > WHEEL_LIMIT) throw new Error(`${key} must be a finite number between -${WHEEL_LIMIT} and ${WHEEL_LIMIT}`);
    wheel[key] = value;
  }
  return wheel;
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
