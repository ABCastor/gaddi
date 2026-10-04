export function extensionParams(params) {
    const operation = params.operation ?? 'list';
    if (!['list', 'reload', 'enable', 'disable', 'uninstall', 'install'].includes(String(operation)))
        throw new Error('invalid extension operation');
    if (operation === 'install') {
        if (params.extensionId !== undefined || typeof params.path !== 'string' || !params.path.trim())
            throw new Error('install requires a local folder path and no extensionId');
        return { operation: 'install', path: params.path };
    }
    if (params.path !== undefined)
        throw new Error('path applies only to extension install');
    if (operation === 'list') {
        if (params.extensionId !== undefined)
            throw new Error('list does not take an extensionId');
        return { operation: 'list' };
    }
    if (typeof params.extensionId !== 'string' || !/^[a-p]{32}$/.test(params.extensionId) && params.extensionId !== 'self')
        throw new Error('extensionId must be self or a Chrome extension ID');
    return { operation: operation, extensionId: params.extensionId };
}
export function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function parseJSON(text) { return JSON.parse(text); }
export function errorMessage(error) {
    return error instanceof Error ? error.message : isRecord(error) ? String(error.message) : String(error);
}
export function hasErrorCode(error, code) {
    return isRecord(error) && error.code === code;
}
export function isTabInfo(value) {
    return isRecord(value)
        && ['id', 'tabId', 'tab', 'groupId', 'windowId'].every(key => value[key] === undefined || typeof value[key] === 'number')
        && ['url', 'title', 'group'].every(key => value[key] === undefined || typeof value[key] === 'string')
        && (value.active === undefined || typeof value.active === 'boolean');
}
// Check only the result fields a client consumes; arbitrary eval and policy payloads stay opaque.
export function isBrokerResult(method, value) {
    switch (method) {
        case 'signin': return isRecord(value) && ['signed_in', 'needs_you', 'no_login', 'choose', 'failed'].includes(String(value.outcome))
            && typeof value.site === 'string' && ['item_title', 'step', 'reason'].every(key => value[key] === undefined || typeof value[key] === 'string')
            && Object.keys(value).every(key => ['outcome', 'site', 'item_title', 'step', 'reason'].includes(key));
        case 'tabs': return isRecord(value) && Array.isArray(value.tabs) && value.tabs.every(isTabInfo);
        case 'bookmarks': return isRecord(value) && Array.isArray(value.bookmarks) && value.bookmarks.every(item => isRecord(item) && ['path', 'title', 'url'].every(key => typeof item[key] === 'string'));
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
export function versionParam(value) {
    if (value === undefined || value === '')
        return undefined;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value))
        throw new Error('version must be a short opaque string');
    return value;
}
// Shared by broker and extension, including clients that bypass MCP schemas.
export function waitParams(params) {
    const keys = ['text', 'selector', 'url'].filter(key => params[key] !== undefined);
    if (keys.length !== 1)
        throw new Error('wait requires exactly one of text, selector or url');
    const key = keys[0], value = params[key];
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`wait ${key} must be a nonempty string`);
    if (params.gone !== undefined && typeof params.gone !== 'boolean')
        throw new Error('gone must be boolean');
    if (key === 'url' && params.gone === true)
        throw new Error('gone applies only to text or selector');
    const timeout = params.timeout ?? 10000;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0 || timeout > 20000)
        throw new Error('timeout must be between 0 and 20000 ms');
    return { [key]: value, timeout, ...(params.gone !== undefined ? { gone: params.gone } : {}) };
}
