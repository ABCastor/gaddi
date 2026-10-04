import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseLogin, getCredentials, getOTP, listLogins, runSignin, signinSite } from '../../daemon/signin.ts';
import { createSigninSecrets } from '../../daemon/signin-secrets.ts';
import type { ChromeParams, SigninProbe } from '../../shared/protocol.ts';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-signin-credentials-'));
const originalEnv = { ...process.env };
const user = 'fake-user@example.test', password = 'fake-password-only-test', otp = '001234';
const site = 'https://login.example.com';
const item = { id: 'item-main', title: 'Example login', urls: ['https://example.com'] };
let count = 0;
const pass = (name: string) => { count++; console.log(`PASS ${name}`); };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
fs.writeFileSync(path.join(scratch, 'op'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SIGNIN_TEST_CALLS, JSON.stringify({args,opEnv:Object.keys(process.env).filter(k=>/^OP_/i.test(k))})+'\\n');
const mode = process.env.SIGNIN_TEST_MODE;
if (mode === 'fail') { console.error('unsafe ${password} ${user} ${otp}'); process.exit(1); }
if (mode === 'bad-json') { console.log('invalid ${password}'); process.exit(0); }
if (args[1] === 'list') console.log(JSON.stringify([{id:'item-main',title:'Example login',urls:[{href:'https://example.com'}]}]));
else if (args.includes('--otp')) { if(mode === 'no-otp') process.exit(1); console.log('${otp}'); }
else console.log(JSON.stringify([{id:'username',label:'username',value:'${user}'},{id:'password',label:'password',value:'${password}'}]));
`, { mode: 0o700 });
process.env.PATH = `${scratch}:${process.env.PATH}`;
process.env.OP_SERVICE_ACCOUNT_TOKEN = 'fake-machine-token';
process.env.OP_SESSION_fake = 'fake-session';
process.env.OP_ACCOUNT = 'fake-account';
process.env.SIGNIN_TEST_CALLS = path.join(scratch, 'calls.jsonl');
const calls = () => fs.existsSync(process.env.SIGNIN_TEST_CALLS!) ? fs.readFileSync(process.env.SIGNIN_TEST_CALLS!, 'utf8').trim().split('\n').map(line => JSON.parse(line) as {args:string[];opEnv:string[]}) : [];

try {
  assert.equal(signinSite('https://example.com/login?q=x'), 'https://example.com');
  assert.equal(signinSite('http://127.0.0.1:1234/login'), 'http://127.0.0.1:1234');
  assert.equal(signinSite('http://localhost:1234/login'), 'http://localhost:1234');
  for (const invalid of ['http://example.com', 'http://127.1', 'http://2130706433', 'http://localhost.', 'http://LOCALHOST', 'https://user:pass@example.com', 'https://@example.com', 'file:///x', 'https://example.com\\@evil.com', ' https://example.com', null]) {
    assert.throws(() => signinSite(invalid));
  }
  pass('origin validation refuses credentials, insecure sites and loopback aliases');

  const match = (stored: string, target: string) => chooseLogin([{ ...item, urls: [stored] }], target).outcome;
  assert.equal(match('http://example.com', site), 'selected');
  assert.equal(match('http://accounts.example.co.uk', 'https://app.example.co.uk'), 'selected');
  assert.equal(match('http://first.pages.dev', 'https://second.pages.dev'), 'no_login');
  assert.equal(match('http://user:password@example.com', site), 'no_login');
  assert.equal(match('http://@example.com', site), 'no_login');
  assert.equal(match('ftp://example.com', site), 'no_login');
  assert.throws(() => match('http://example.com', 'http://example.com'));
  assert.equal(match('https://accounts.example.co.uk', 'https://app.example.co.uk'), 'selected');
  assert.equal(match('https://example.co.uk', 'https://evil.co.uk'), 'no_login');
  assert.equal(match('https://first.github.io', 'https://second.github.io'), 'no_login');
  assert.equal(match('https://first.pages.dev', 'https://second.pages.dev'), 'no_login');
  assert.equal(match('https://first.appspot.com', 'https://second.appspot.com'), 'no_login');
  assert.equal(match('https://a.first.pages.dev', 'https://b.first.pages.dev'), 'selected');
  assert.equal(match('https://a.b.ck', 'https://other.b.ck'), 'no_login');
  assert.equal(match('https://a.www.ck', 'https://b.www.ck'), 'selected');
  assert.equal(match('https://a.city.kawasaki.jp', 'https://b.city.kawasaki.jp'), 'selected');
  assert.equal(match('https://a.example.unknownsuffix', 'https://b.example.unknownsuffix'), 'no_login');
  assert.equal(match('https://127.0.0.1', 'https://127.0.0.2'), 'no_login');
  assert.equal(match('https://bücher.de', 'https://shop.xn--bcher-kva.de'), 'selected');
  assert.equal(match('https://example.com.evil.com', site), 'no_login');
  assert.equal(chooseLogin([item], site, 'another').outcome, 'failed');
  assert.equal(chooseLogin([item, {...item,id:'second',title:'Other login'}], site).outcome, 'choose');
  const choose = chooseLogin([item, {...item,id:'second',title:'Other login'}], site);
  assert.equal('reason' in choose && choose.reason, '["Example login","Other login"]');
  assert.equal(chooseLogin([item, {...item,id:'second',title:'Other login'}], site, 'second').outcome, 'selected');
  pass('canonical ICANN, private, wildcard, exception and IDN matching');

  assert.deepEqual(await listLogins(), [item]);
  assert.deepEqual(await getCredentials(item), {username:user,password});
  assert.equal(await getOTP(item), otp);
  assert.ok(calls().every(call => call.opEnv.length === 0));
  assert.deepEqual(calls()[0].args, ['item','list','--categories','Login','--format','json']);
  assert.deepEqual(calls()[1].args, ['item','get',item.id,'--fields','label=username,label=password','--reveal','--format','json']);
  for (const mode of ['fail','bad-json']) {
    process.env.SIGNIN_TEST_MODE = mode;
    await assert.rejects(listLogins(), { message:'1Password login list failed' });
    await assert.rejects(getCredentials(item), { message:'1Password credentials unavailable' });
  }
  assert.equal(await getOTP(item), undefined);
  delete process.env.SIGNIN_TEST_MODE;
  pass('fake op has clean environment, documented arguments and sanitized failures');

  const store = createSigninSecrets({ttlMs:100});
  store.remember(1, [user,password,otp]);
  store.remember(1, ['second-secret']);
  store.remember(2, ['tab-two']);
  const output = store.redact({ [password]: {text:`${user} ${password} ${otp} second-secret tab-two`, code:1234}, error: new Error(password)}, 1);
  const serialized = JSON.stringify(output);
  for (const value of [user,password,otp,'second-secret']) assert.equal(serialized.includes(value), false);
  assert.ok(serialized.includes('tab-two'));
  assert.equal(JSON.stringify(store.redact(output)).includes('tab-two'), false);
  assert.equal(store.redact(Buffer.from(password)), '[redacted]');
  store.clear(1);
  assert.equal(store.redact(password, 1), password);
  assert.equal(store.redact('tab-two', 2), '[redacted]');
  store.stop();
  assert.equal(store.redact('tab-two'), 'tab-two');
  const expiring = createSigninSecrets({ttlMs:25});
  const retained:Buffer[] = [];
  const originalFrom = Buffer.from;
  Buffer.from = ((...args: Parameters<typeof Buffer.from>) => {const buffer = Reflect.apply(originalFrom, Buffer, args) as Buffer; retained.push(buffer); return buffer;}) as typeof Buffer.from;
  try { expiring.remember(3, [password]); } finally { Buffer.from = originalFrom; }
  assert.equal(expiring.redact(password), '[redacted]');
  await delay(45);
  assert.equal(expiring.redact(password), password);
  assert.ok(retained.length > 0 && retained.every(buffer => buffer.every(byte => byte === 0)));
  expiring.stop();
  pass('recursive values, keys, numeric OTP, per-tab retention, clear and zeroed expiry');
  const envelopes = createSigninSecrets();
  envelopes.remember(4, ['id', 'result', password]);
  assert.deepEqual(envelopes.redact({id:'id',result:{reason:password}}, undefined, false), {id:'id',result:{reason:'[redacted]'}});
  assert.deepEqual(envelopes.redact({id:password}), {'[redacted]':'[redacted]'});
  envelopes.stop();
  pass('fixed response keys preserved only when explicitly requested');

  async function flow(mode: 'one'|'two'|'otp'|'challenge'|'phishing'|'bridge-error'|'unchanged'|'no-otp'|'initial-challenge'|'post-op-phishing'|'pre-submit-phishing'|'delayed-otp'|'delayed-sms'|'delayed-captcha'|'disabled-password') {
    let stage = mode === 'two' ? 'username' : 'password', submitted = false;
    let probes = 0;
    let loadingSince = 0;
    const remembered = new Set<string>(), typed: string[] = [], submits: string[] = [];
    const beforeCalls = calls().length;
    const request = async (name: string, params: ChromeParams, deadline?: number) => {
      assert.equal(params.tab, 7);
      assert.equal(params.signin?.site, site);
      assert.ok(deadline && deadline > Date.now() && deadline <= Date.now()+15000);
      if (name === 'signinProbe') {
        probes++;
        if (stage === 'loading' && Date.now()-loadingSince >= 200) stage = mode === 'delayed-otp' ? 'otp' : 'challenge';
        const probe:SigninProbe = {url:site+'/login',signature:stage};
        if (mode === 'initial-challenge' || stage === 'challenge') probe.challenge = true;
        if (mode === 'phishing' && probes > 2 || mode === 'post-op-phishing' && probes > 1 || mode === 'pre-submit-phishing' && probes > 5) probe.url='https://evil.com/login';
        if (stage === 'username') probe.username='#user';
        if (stage === 'password') {probe.username='#user';probe.password='#pass';}
        if (stage === 'disabled-password') probe.passwordPresent=true;
        if (stage === 'otp') probe.otp='#otp';
        if (stage === 'complete') probe.url=site+'/home';
        return probe;
      }
      if (name === 'signinType') {
        assert.ok(remembered.has(params.text!));
        if (mode === 'bridge-error') throw new Error(password);
        typed.push(params.signin!.kind!);
      } else if (name === 'signinSubmit') {
        submits.push(params.signin!.kind!); submitted = true;
        stage = stage === 'username' ? 'password' : stage === 'password' && (mode === 'otp' || mode === 'no-otp') ? 'otp' : mode === 'challenge' ? 'challenge' : mode === 'unchanged' ? 'password' : 'complete';
        if (params.signin?.kind === 'password' && mode.startsWith('delayed-')) { stage='loading'; loadingSince=Date.now(); }
        if (params.signin?.kind === 'password' && mode === 'disabled-password') stage='disabled-password';
      } else assert.fail('unexpected internal method');
      return {};
    };
    if (mode === 'no-otp') process.env.SIGNIN_TEST_MODE='no-otp';
    const result = await runSignin({site,item,tab:7,request,remember:value=>remembered.add(value)});
    delete process.env.SIGNIN_TEST_MODE;
    assert.equal(JSON.stringify(result).includes(password), false);
    assert.equal(JSON.stringify(result).includes(user), false);
    assert.equal(JSON.stringify(result).includes(otp), false);
    return {result,typed,submits,submitted,newCalls:calls().slice(beforeCalls)};
  }
  assert.equal((await flow('one')).result.outcome, 'signed_in');
  const two = await flow('two');
  assert.equal(two.result.outcome, 'signed_in');
  assert.deepEqual(two.submits, ['username','password']);
  const withOTP=await flow('otp');
  assert.equal(withOTP.result.outcome, 'signed_in');
  assert.deepEqual(withOTP.typed, ['username','password','otp']);
  assert.equal(withOTP.newCalls.filter(call=>call.args.includes('--otp')).length,1);
  assert.equal((await flow('no-otp')).result.outcome, 'needs_you');
  assert.equal((await flow('challenge')).result.outcome, 'needs_you');
  const initial = await flow('initial-challenge');
  assert.equal(initial.result.outcome, 'needs_you');
  assert.equal(initial.newCalls.length, 0);
  for (const mode of ['phishing','post-op-phishing','bridge-error'] as const) {
    const refused = await flow(mode);
    assert.equal(refused.result.outcome, 'failed');
    assert.equal(refused.typed.length,0);
  }
  const preSubmit = await flow('pre-submit-phishing');
  assert.equal(preSubmit.result.outcome, 'failed');
  assert.deepEqual(preSubmit.typed, ['username','password']);
  assert.equal(preSubmit.submitted, false);
  pass('one-step, two-step, optional OTP, challenge, redirect and bridge-error flows');
  const cleanStarted = Date.now();
  assert.equal((await flow('one')).result.outcome, 'signed_in');
  assert.ok(Date.now()-cleanStarted >= 1000);
  const delayedOTP = await flow('delayed-otp');
  assert.equal(delayedOTP.result.outcome, 'signed_in');
  assert.deepEqual(delayedOTP.typed, ['username','password','otp']);
  assert.equal((await flow('delayed-sms')).result.outcome, 'needs_you');
  assert.equal((await flow('delayed-captcha')).result.outcome, 'needs_you');
  pass('stable success waits while delayed OTP, SMS and captcha are handled');
  const start = Date.now();
  const [unchanged, disabled] = await Promise.all([flow('unchanged'),flow('disabled-password')]);
  assert.equal(unchanged.result.outcome,'needs_you');
  assert.equal(disabled.result.outcome,'needs_you');
  assert.ok(Date.now()-start < 15500);
  pass('unchanged or disabled password forms cannot claim success and wait is bounded');
  console.log(`== signin credentials: ${count} passed, 0 failed`);
} finally {
  process.env = originalEnv;
  fs.rmSync(scratch, {recursive:true,force:true}); // Test-owned temporary fixture only.
}
