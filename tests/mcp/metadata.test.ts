import { isRecord } from '../../shared/protocol.ts';
// MCP handshake and exact public surface require no daemon or browser.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client = new Client({ name: 'metadata-test', version: '0' });
try {
  await client.connect(new StdioClientTransport({ command: fileURLToPath(new URL('../../mcp/server.mjs', import.meta.url)),
    // Startup now registers a lifetime socket; metadata checks must never reach the live broker.
    env: { GADDI_SOCKET: `/tmp/gaddi-metadata-${crypto.randomUUID()}.sock` } }));
  const listed = await client.listTools();
  // Agents never decide: no tool reaches approval.remote or a remote.* method (the owner's other device,
  // daemon/remote.ts), and none even mentions one. Checked before the exact list so a stray tool names itself.
  for (const tool of listed.tools) {
    assert.ok(!/remote|phone|another device/i.test(`${tool.name} ${tool.description ?? ''} ${JSON.stringify(tool.inputSchema)}`), `ASSERT_REMOTE_NO_MCP: ${tool.name}`);
  }
  console.log('PASS ASSERT_REMOTE_NO_MCP');
  assert.deepEqual(listed.tools.map(t => t.name).sort(), [
    'tabs', 'bookmarks', 'look', 'wait', 'read', 'open', 'goto', 'back', 'click', 'type', 'press', 'hover', 'scroll', 'select', 'upload', 'signin', 'eval', 'emulate', 'screenshot', 'close', 'show', 'group', 'approvals', 'grant', 'status', 'extensions',
  ].map(n => 'browser_' + n).sort());
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description);
    assert.ok(tool.inputSchema.properties);
    assert.ok(tool.description.length < 110, tool.name);
    assert.ok(!JSON.stringify(tool).includes('session'), tool.name);
    const readOnly = ['tabs', 'look', 'wait', 'bookmarks', 'screenshot', 'approvals', 'status'].includes(tool.name.slice(8));
    assert.equal(tool.annotations?.readOnlyHint, readOnly ? true : undefined, tool.name);
    if (tool.name === 'browser_emulate') assert.deepEqual(tool.inputSchema.properties.animationSpeed,
      { type: 'number', exclusiveMinimum: 0, maximum: 1 });
    if (tool.name === 'browser_open') { const group = tool.inputSchema.properties.group; assert.ok(isRecord(group)); assert.equal(group.type, 'string'); }
  }
  const schema = (name: string) => { const tool = listed.tools.find(tool => tool.name === 'browser_' + name); assert.ok(tool); const schema = tool.inputSchema; assert.ok(schema.properties); assert.ok(schema.required); return { ...schema, properties: schema.properties, required: schema.required }; };
  assert.deepEqual(schema('close').required, ['tabs']);
  assert.deepEqual(schema('show').required, ['tab']);
  assert.deepEqual([...schema('group').required].sort(), ['group', 'tabs']);
  for (const name of ['close', 'group']) {
    const ids = schema(name).properties.tabs;
    assert.ok(isRecord(ids)); assert.ok(isRecord(ids.items));
    assert.equal(ids.type, 'array'); assert.equal(ids.minItems, 1); assert.equal(ids.maxItems, 100);
    assert.equal(ids.items.type, 'integer'); assert.equal(ids.items.minimum, 0);
    assert.equal(ids.items.maximum, Number.MAX_SAFE_INTEGER);
  }
  assert.deepEqual([...schema('upload').required].sort(), ['path', 'selector']);
  assert.deepEqual(schema('type').properties.mode, { type: 'string', enum: ['replace', 'append'] }, 'ASSERT_APPEND_SCHEMA');
  assert.ok(!schema('type').required.includes('mode'), 'ASSERT_APPEND_SCHEMA');
  assert.match(listed.tools.find(t => t.name === 'browser_type')!.description!, /preserving chips\/mentions/, 'ASSERT_APPEND_SCHEMA');
  assert.match(listed.tools.find(t => t.name === 'browser_look')!.description!, /floating menus\/suggestions/, 'ASSERT_MENU_GUIDANCE');
  for (const name of ['click', 'type', 'press', 'select', 'scroll', 'hover', 'upload']) {
    const version = schema(name).properties.version;
    assert.ok(isRecord(version), 'ASSERT_VERSION_MCP');
    assert.equal(version.type, 'string', 'ASSERT_VERSION_MCP');
    assert.equal(version.maxLength, 128, 'ASSERT_VERSION_MCP');
    assert.equal(version.pattern, '^[A-Za-z0-9_.:-]*$', 'ASSERT_VERSION_MCP');
    assert.ok(!schema(name).required.includes('version'), 'ASSERT_VERSION_MCP');
  }
  console.log('PASS ASSERT_VERSION_MCP');
  // browser_grant: ask once for a few holds to be waived on named pages. The arguments are bounded here and again by the broker.
  assert.deepEqual([...schema('grant').required].sort(), ['minutes', 'rules'], 'ASSERT_GRANT_SCHEMA');
  const grantRules = schema('grant').properties.rules;
  assert.ok(isRecord(grantRules) && isRecord(grantRules.items), 'ASSERT_GRANT_SCHEMA');
  assert.equal(grantRules.type, 'array', 'ASSERT_GRANT_SCHEMA'); assert.equal(grantRules.minItems, 1, 'ASSERT_GRANT_SCHEMA'); assert.equal(grantRules.maxItems, 20, 'ASSERT_GRANT_SCHEMA');
  assert.equal(grantRules.items.type, 'string', 'ASSERT_GRANT_SCHEMA'); assert.equal(grantRules.items.maxLength, 300, 'ASSERT_GRANT_SCHEMA');
  assert.match(String(grantRules.description), /upload\|post\|delete/, 'ASSERT_GRANT_SCHEMA');
  assert.match(String(grantRules.description), /https URL prefix/, 'ASSERT_GRANT_SCHEMA');
  assert.deepEqual(schema('grant').properties.minutes, { type: 'integer', minimum: 5, maximum: 720 }, 'ASSERT_GRANT_SCHEMA');
  assert.deepEqual(schema('grant').properties.label, { type: 'string', maxLength: 60 }, 'ASSERT_GRANT_SCHEMA');
  assert.match(listed.tools.find(t => t.name === 'browser_grant')!.description!, /Touch ID/, 'ASSERT_GRANT_SCHEMA');
  console.log('PASS ASSERT_GRANT_SCHEMA');
  for (const axis of ['dx', 'dy']) {
    assert.deepEqual(schema('scroll').properties[axis], { type: 'number', minimum: -100000, maximum: 100000 }, 'ASSERT_SCROLL_SCHEMA');
  }
  assert.deepEqual(schema('scroll').required, [], 'ASSERT_SCROLL_SCHEMA');
  assert.match(listed.tools.find(t => t.name === 'browser_scroll')!.description!, /dx\/dy wheel pixels \(over selector if given\), or to a selector/, 'ASSERT_SCROLL_SCHEMA');
  console.log('PASS ASSERT_SCROLL_SCHEMA');
  const shownTab = schema('show').properties.tab; assert.ok(isRecord(shownTab)); assert.equal(shownTab.maximum, Number.MAX_SAFE_INTEGER);
  const estimate = Math.ceil(JSON.stringify(listed).length / 4);
  console.log(`MCP tools/list: ${listed.tools.length} tools, ${estimate} total estimated tokens (JSON characters / 4; limit 2500)`);
  assert.ok(estimate < 2500, 'tools/list token budget exceeded');
  const instructions = client.getInstructions();
  assert.ok(instructions);
  const words = instructions.trim().split(/\s+/).length;
  assert.ok(words <= 120);
  assert.match(instructions, /Never ask for passwords/);
  assert.match(instructions, /Touch ID/);
  assert.match(instructions, /type mode:append after chips\/mentions/, 'ASSERT_APPEND_SCHEMA');
  assert.match(instructions, /owner may pre-allow sends/, 'ASSERT_SEND_GUIDANCE');
  assert.doesNotMatch(instructions, /agents cannot grant permissions/, 'ASSERT_GRANT_GUIDANCE');
  assert.match(instructions, /ask for a session grant with browser_grant.*only the owner approves it in Gaddi/, 'ASSERT_GRANT_GUIDANCE');
  assert.match(instructions, /Payments, sends, sign-in, security stay held/, 'ASSERT_GRANT_GUIDANCE');
  assert.deepEqual(Object.keys(schema('signin').properties).sort(), ['approval', 'item', 'tab']);
  console.log(`PASS metadata: exact 26 tools; ${words} instruction words; within token budget`);
} finally { await client.close(); }
