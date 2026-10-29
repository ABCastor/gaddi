import assert from 'node:assert/strict';
import { redactURLs, redactURLText } from '../../shared/url-redaction.ts';
import { mapSocketError, pageResult, plainResult, wrapPage } from '../../mcp/map.ts';

let passed = 0;
const marker = 'SYNTHETIC_URL_CREDENTIAL_0123456789';
const safe = (value: unknown) => assert.ok(!JSON.stringify(value).includes(marker), 'ASSERT_URL_REDACTION: synthetic URL credential escaped');
function check(name: string, fn: () => void) { fn(); passed++; console.log(`PASS ${name}`); }
const names = ['code', 'state', 'id_token', 'access_token', 'token', 'sig', 'key', 'password', 'session',
  'refresh_token', 'client_secret', 'session_id', 'api-key', 'SAMLResponse', 'X-Amz-Signature',
  'X-Amz-Security-Token', 'X-Goog-Credential', 'oauth_code', 'oauth_state', 'id_token_hint'];
check('query/fragment/SPA parameters, repeats, case and encoded names', () => {
  for (const name of names) for (const separator of ['?', '#', '#/callback?', '?page=2&', '#page=2&']) {
    for (const key of [name, name.toUpperCase(), [...name].map(c => '%' + c.charCodeAt(0).toString(16)).join('')]) {
      const output = redactURLText(`https://fixture.example/callback${separator}${key}=${marker}&${key}=${marker}`);
      safe(output); assert.equal(redactURLText(output), output, 'redaction must be idempotent');
    }
  }
});
check('ordinary query values and URL shape survive exactly; plain prose is untouched', () => {
  const ordinary = 'https://fixture.example/search?q=hello%20world&page=2#section=help';
  assert.equal(redactURLText(ordinary), ordinary);
  assert.equal(redactURLText('Origin /callback, status 200, code sample, session rules.'), 'Origin /callback, status 200, code sample, session rules.');
  assert.equal(redactURLText('/callback?page=2&code=' + marker + '#section=help'), '/callback?page=2&code=[redacted]#section=help');
});
check('URL userinfo, relative links, HTML attributes and escaped ampersands', () => {
  safe(redactURLText(`https://user:${marker}@fixture.example/page`));
  safe(redactURLText(`<a href="/callback?page=2&amp;code=${marker}&amp;state=${marker}">Callback</a>`));
  safe(redactURLText(`/callback?page=2&#38;code=${marker}&#x26;state=${marker}`));
  safe(redactURLText(`/callback?code&#61;${marker}`));
});
check('nested redirect URLs cannot hide credentials behind repeated percent encoding', () => {
  let nested = `https://fixture.example/callback?code=${marker}&page=2#state=${marker}`;
  for (let n = 0; n < 9; n++) {
    safe(redactURLText('https://outer.example/start?redirect_uri=' + nested));
    nested = encodeURIComponent(nested);
  }
  const unencoded = `https://outer.example/?return=https://inner.example/?code=${marker}`;
  safe(redactURLText(unencoded));
});
check('malformed URL escapes do not defeat ASCII-sensitive parameter names', () => {
  safe(redactURLText(`/callback?%63ode=${marker}&page=%broken`));
  safe(redactURLText(`relative?redirect_uri=https%3A%2F%2Finner.example%2F%3Fcode%3D${marker}%zz`));
});
check('all nested values and URL-bearing keys are cloned without corrupting protocol keys', () => {
  const url = `https://fixture.example/callback?code=${marker}`;
  const input = { id: 77, signature: 'ordinary-proof', version: 'epoch:2', nested: [{ url, title: url, [url]: 42 }], optional: undefined };
  const output = redactURLs(input); safe(output);
  assert.equal(input.nested[0].url, url); assert.equal(output.id, 77); assert.equal(output.version, 'epoch:2');
  assert.equal(output.signature, 'ordinary-proof'); assert.equal(output.optional, undefined);
  const proto = JSON.parse('{"__proto__":{"url":"' + url + '"}}');
  safe(redactURLs(proto)); assert.equal(({} as Record<string, unknown>).url, undefined);
});
check('JSONL migration text stays parseable and retains hashes/correlation fields', () => {
  const line = JSON.stringify({ url: `https://fixture.example/?code=${marker}`, id: 'test-id', actionHash: 'a'.repeat(64) });
  const output = JSON.parse(redactURLText(line)); safe(output); assert.equal(output.id, 'test-id'); assert.equal(output.actionHash, 'a'.repeat(64));
});
check('MCP wrappers and local errors sanitize even without a broker', () => {
  const url = `https://fixture.example/callback?code=${marker}`;
  const wrapped = wrapPage(url, `body ${url}`);
  safe(wrapped); assert.ok(wrapped.startsWith('[untrusted page content from https://fixture.example/callback?code=[redacted]]\n'));
  const result = pageResult(url, url); safe(result); assert.ok(result.content[0].text.includes('code=[redacted]]\n'));
  safe(plainResult({ url }));
  safe(mapSocketError({ message: `navigation failed ${url}` }));
  safe(mapSocketError({ code: 'held', approval: { id: 'fixture', reason: `await ${url}` } }));
});
console.log(`== URL redaction units: ${passed} passed, 0 failed`);
