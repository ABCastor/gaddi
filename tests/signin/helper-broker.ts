import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { approvalMessage } from '../../daemon/proof.ts';
import { isRecord } from '../../shared/protocol.ts';
import type { BrokerParams, ChromeRequest, Reply } from '../../shared/protocol.ts';
import type { FakeDaemon } from '../bridge/fake-daemon.ts';

// Production broker -> native transport relay -> real extension -> local HTTP fixture.
// Only op and owner authentication are stand-ins. No installed service, vault or real account.
// downloadHold: start the broker with an opt-in hold.downloads overlay and exercise only
// the held capture path. Without it, the default policy is exercised: captures do not ask.
export async function exerciseHelperBroker({site,daemon,state,username,password,reset,downloadHold=false}: {
  site:string; daemon:Pick<FakeDaemon,'request'>; state:string; username:string; password:string; reset:()=>void; downloadHold?:boolean;
}) {
  const repo=path.resolve(import.meta.dirname,'../..'), home=path.join(state,'helper-broker'); fs.mkdirSync(home);
  const socket=path.join(os.tmpdir(),`gaddi-helper-broker-${process.pid}.sock`), lock=path.join(home,'locked'), saves=path.join(home,'saves');
  const {publicKey,privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  fs.writeFileSync(path.join(home,'approver.pub'),publicKey.export({type:'spki',format:'pem'}));
  fs.writeFileSync(path.join(home,'op'),`#!${process.execPath}
import fs from 'node:fs'; const args=process.argv.slice(2);
if(fs.existsSync(${JSON.stringify(lock)})){setTimeout(()=>console.log('[]'),8000);}else if(args[1]==='create'){
 let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const value=JSON.parse(input);
 if(args[args.indexOf('--vault')+1]!=='aaaaaaaaaaaaaaaaaaaaaaaaaa'||!args.includes('--generate-password=letters,digits,symbols,32'))process.exit(2);
 fs.appendFileSync(${JSON.stringify(saves)},'saved\\n');console.log(JSON.stringify({id:'helper-new-item',title:value.title,vault:{id:'aaaaaaaaaaaaaaaaaaaaaaaaaa'}}));});
}else if(args[1]==='list')console.log(JSON.stringify([{id:'helper-new-item',title:'Helper fixture',urls:[{href:${JSON.stringify(site)}}]}]));
else console.log(${JSON.stringify(JSON.stringify([{label:'username',value:username},{label:'password',value:password}]))});
`,{mode:0o700});
  fs.writeFileSync(path.join(home, 'agent-cred'), 'agent-value-from-file\n', { mode: 0o600 });
const env={...process.env,PATH:`${home}:${process.env.PATH}`,GADDI_HOME:home,GADDI_SOCKET:socket,GADDI_OP_TOKEN_FILE:path.join(home,'agent-cred'),GADDI_OP_HOME:path.join(home,'op-home'),
    GADDI_AUDIT:path.join(home,'audit.jsonl'),GADDI_STATE:path.join(home,'state.json'),GADDI_APPROVER_PUB:path.join(home,'approver.pub'),GADDI_APP_LAUNCHER:'/usr/bin/true',GADDI_POLICY_OFF:process.env.GADDI_HELPER_POLICY_OFF==='1'?'1':'0'};
  if(downloadHold)fs.writeFileSync(path.join(home,'policy.json'),JSON.stringify({hold:{downloads:true}}));
  let entry=path.join(repo,'daemon/daemon.mjs');
  // Falsification mutants: each removes one guarantee so its assertion must go red.
  const mutations:Record<string,[string,string,string]>={
    'create-hold':['daemon/daemon.ts',"creating ? { outcome: 'hold', reason: 'create and save a new 1Password login' }","creating ? { outcome: 'allow' }"],
    'download-always-hold':['daemon/downloads.ts',"!policy.off && policy.hold.downloads === true ?","!policy.off ?"],
    'download-ignores-switch':['daemon/downloads.ts',"!policy.off && policy.hold.downloads === true ?","false ?"],
    'download-drops-click-hold':['daemon/daemon.ts',"check = strictest(check, checkDownload(policy));","check = checkDownload(policy);"],
  };
  const mutation=process.env.GADDI_HELPER_BREAK_CREATE_HOLD==='1'?'create-hold':process.env.GADDI_HELPER_MUTATE;
  if(mutation) {
    assert.ok(Object.hasOwn(mutations,mutation),`unknown mutation ${mutation}`);
    const [relative,marker,replacement]=mutations[mutation]!;
    const mutant=path.join(home,'mutant');fs.mkdirSync(mutant);
    for(const dir of ['daemon','shared','policy'])fs.cpSync(path.join(repo,dir),path.join(mutant,dir),{recursive:true});
    fs.writeFileSync(path.join(mutant,'package.json'),JSON.stringify({type:'module'}));
    const file=path.join(mutant,relative),source=fs.readFileSync(file,'utf8');
    assert.equal(source.split(marker).length,2,`${mutation} mutation point`);
    fs.writeFileSync(file,source.replace(marker,replacement));
    entry=path.join(mutant,'daemon/daemon.mjs');
  }
  const broker=spawn(process.execPath,[entry],{env,stdio:['ignore','ignore','pipe']});
  let diagnostics='';broker.stderr.on('data',chunk=>diagnostics+=chunk);
  const clients=new Set<net.Socket>(); let bridge:net.Socket|undefined;
  const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
  const safe=(value:unknown)=>assert.ok(!JSON.stringify(value).includes(password),'helper public output must not contain the generated password');
  function call(method:string,params:BrokerParams={}):Promise<Reply>{
    return new Promise((resolve,reject)=>{
      const client=net.connect(socket);clients.add(client);let buffer='';const id=crypto.randomUUID();
      const timer=setTimeout(()=>{client.destroy();reject(new Error('Helper broker request timed out'));},30000);
      client.setEncoding('utf8');client.on('connect',()=>client.write(JSON.stringify({id,method,params:{caller:'helper-acceptance',...params}})+'\n'));
      client.on('error',e=>{clearTimeout(timer);reject(e);});
      client.on('data',chunk=>{buffer+=chunk;const end=buffer.indexOf('\n');if(end<0)return;clearTimeout(timer);client.destroy();const reply=JSON.parse(buffer.slice(0,end)) as Reply;safe(reply);resolve(reply);});
    });
  }
  async function result(method:string,params:BrokerParams={}){const reply=await call(method,params);assert.equal(reply.error,undefined,`helper ${method}`);return reply.result;}
  async function approve(id:string){
    const list=await result('approvals.list');assert.ok(isRecord(list)&&Array.isArray(list.pending));
    const approval=list.pending.find(a=>isRecord(a)&&a.id===id);assert.ok(isRecord(approval));
    const ts=Date.now(),sig=crypto.sign('sha256',Buffer.from(approvalMessage('grant',approval,ts,false)),privateKey).toString('base64');
    await result('approval.grant',{id,proof:{ts,sig}});
  }
  async function action(method:string,params:BrokerParams){
    let reply=await call(method,params);
    if(reply.error?.code==='held'){const id=reply.error.approval!.id;await approve(id);reply=await call(method,{...params,approval:id});}
    assert.equal(reply.error,undefined,`helper action ${method}`);return reply.result;
  }
  const output=path.join(os.tmpdir(),`gaddi-helper-export-${crypto.randomUUID()}.zip`);
  // Outside Downloads and temp: refused before any write (the state dir itself lives under temp).
  const outsideOutput=path.join(os.homedir(),`gaddi-helper-outside-${crypto.randomUUID()}.zip`);
  try {
    for(let n=0;n<200&&!fs.existsSync(socket)&&broker.exitCode===null;n++)await pause(20);
    assert.ok(fs.existsSync(socket),'helper broker started');
    bridge=net.connect(socket);bridge.setEncoding('utf8');let buffer='';
    bridge.on('connect',()=>bridge!.write(JSON.stringify({id:'attach',method:'bridge.attach',params:{kind:'chrome'}})+'\n'));
    bridge.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\n'))>=0){
      const request=JSON.parse(buffer.slice(0,end)) as ChromeRequest;buffer=buffer.slice(end+1);if(request.id==='attach')continue;
      void daemon.request(request.method,request.params,25000,undefined,request.deadline).then(reply=>bridge?.write(JSON.stringify({...reply,id:request.id})+'\n'));
    }});
    for(let n=0;n<100;n++){const status=await result('bridge.status');if(isRecord(status)&&status.connected)break;await pause(20);}
    if(!process.env.GADDI_HELPER_ONLY_DOWNLOAD&&!downloadHold) {
    reset();
    const opened=await action('open',{url:site+'/signup',group:'Helper fixture'});assert.ok(isRecord(opened)&&typeof opened.id==='number');const tab=opened.id;
    const create={title:'Helper fixture',username,vault:'aaaaaaaaaaaaaaaaaaaaaaaaaa'};
    const held=await result('signin',{tab,create});assert.ok(isRecord(held)&&held.step==='approval','ASSERT_HELPER_CREATE_HOLD');
    assert.equal(fs.existsSync(saves),false,'new login is not saved before signed approval');
    const pending=await result('approvals.list');assert.ok(isRecord(pending)&&Array.isArray(pending.pending));
    const card=pending.pending.at(-1);assert.ok(isRecord(card)&&typeof card.id==='string');
    await approve(card.id);
    for (const changed of [{...create,vault:'bbbbbbbbbbbbbbbbbbbbbbbbbb'},{...create,username:'changed@example.test'}]) {
      const swapped=await result('signin',{tab,create:changed,approval:card.id});
      assert.ok(isRecord(swapped)&&swapped.outcome!=='filled','ASSERT_CREATE_BINDING');
      assert.equal(fs.existsSync(saves),false,'changed vault/username cannot spend the signed create');
    }
    const invalidCreate={...create,password:'fixture-forbidden-field'};
    const invalid=await result('signin',{tab,create:invalidCreate});
    assert.ok(isRecord(invalid)&&invalid.outcome==='failed'&&invalid.step==='signin','ASSERT_CREATE_REJECT_SECRET');
    assert.equal(fs.existsSync(saves),false);
    const filled=await result('signin',{tab,create,approval:card.id});assert.ok(isRecord(filled)&&filled.outcome==='filled','ASSERT_HELPER_CREATE_FILL: '+JSON.stringify(filled));
    assert.equal(fs.readFileSync(saves,'utf8'),'saved\n','exactly one NEW item');
    const replay=await result('signin',{tab,create,approval:card.id});assert.ok(isRecord(replay)&&replay.outcome==='failed');
    assert.equal(fs.readFileSync(saves,'utf8'),'saved\n','approval replay cannot save a second item');
    await action('click',{tab,selector:'button'});
    for(let n=0;n<50;n++){const page=await result('look',{tab});if(isRecord(page)&&String(page.text).includes('Signed in'))break;await pause(100);}
    const page=await result('look',{tab});assert.ok(isRecord(page)&&String(page.text).includes('Signed in'),'fixture server accepted signup');
    await result('close',{tabs:[tab]});
    console.log('PASS public broker signup: signed create, one saved item, trusted fill, ordinary gated submit, server acceptance, no secret output');
    }

    reset();const exportTab=await action('open',{url:site+'/download'});assert.ok(isRecord(exportTab)&&typeof exportTab.id==='number');
    const request={tab:exportTab.id,selector:'#export',download:output};
    if(downloadHold) {
      // Opt-in hold: the capture asks, and the signed card binds the exact path.
      const captureHeld=await call('click',request);assert.equal(captureHeld.error?.code,'held','ASSERT_DOWNLOAD_HOLD');assert.equal(fs.existsSync(output),false);
      const captureId=captureHeld.error!.approval!.id;await approve(captureId);
      // An approved path cannot be swapped to a different local target.
      const swapped=await call('click',{...request,download:output+'.other',approval:captureId});assert.ok(swapped.error);
      assert.equal(fs.existsSync(output+'.other'),false);
      // A failed binding consumes no action; obtain a new exact approval for the intended path.
      const saved=await action('click',request);assert.ok(isRecord(saved)&&saved.downloaded===true,'ASSERT_HELPER_DOWNLOAD');
      assert.equal(fs.readFileSync(output,'utf8'),'fixture generated export');
      await result('close',{tabs:[exportTab.id]});
      console.log('PASS public broker download (hold.downloads on): exact path held, swapped destination refused, generated ZIP saved on disk');
    } else {
      // Default policy: an ordinary export click with a capture returns the file, no card.
      const saved=await call('click',request);
      assert.equal(saved.error,undefined,'ASSERT_DOWNLOAD_NO_HOLD: '+JSON.stringify(saved.error));
      assert.ok(isRecord(saved.result)&&saved.result.downloaded===true&&saved.result.path===fs.realpathSync(output),'ASSERT_HELPER_DOWNLOAD');
      assert.equal(fs.readFileSync(output,'utf8'),'fixture generated export');
      const none=await result('approvals.list');assert.ok(isRecord(none)&&Array.isArray(none.pending)&&none.pending.length===0,'ASSERT_DOWNLOAD_NO_CARD');
      // The file limits still apply without a hold: no overwrite, no path outside Downloads/temp.
      const again=await call('click',request);assert.equal(again.error?.code,'denied','ASSERT_DOWNLOAD_NO_OVERWRITE');
      assert.equal(fs.readFileSync(output,'utf8'),'fixture generated export');
      const outside=await call('click',{...request,download:outsideOutput});assert.equal(outside.error?.code,'denied','ASSERT_DOWNLOAD_CONFINED');
      assert.equal(fs.existsSync(outsideOutput),false);
      await result('close',{tabs:[exportTab.id]});
      // The click's own hold survives a capture: an export button named as a delete still asks.
      const deleteTab=await action('open',{url:site+'/download?delete'});assert.ok(isRecord(deleteTab)&&typeof deleteTab.id==='number');
      const heldClick=await call('click',{tab:deleteTab.id,selector:'#export',download:output+'.delete'});
      assert.equal(heldClick.error?.code,'held','ASSERT_DOWNLOAD_KEEPS_CLICK_HOLD');assert.equal(fs.existsSync(output+'.delete'),false);
      await result('close',{tabs:[deleteTab.id]});
      console.log('PASS public broker download (default): generated ZIP saved with no card; overwrite and outside paths refused; a held click still asks');
    }

    if(!process.env.GADDI_HELPER_ONLY_DOWNLOAD&&!downloadHold) {
    reset();const lockedTab=await action('open',{url:site+'/login'});assert.ok(isRecord(lockedTab)&&typeof lockedTab.id==='number');
    fs.writeFileSync(lock,'locked');const before=Date.now();
    const unavailable=await result('signin',{tab:lockedTab.id});assert.ok(isRecord(unavailable)&&unavailable.outcome==='needs_you'&&unavailable.step==='1password');
    assert.match(String(unavailable.reason),/unavailable to agents/);assert.ok(Date.now()-before<6500,'ASSERT_HELPER_LOCK');
    await result('close',{tabs:[lockedTab.id]});
    const audit=fs.readFileSync(path.join(home,'audit.jsonl'),'utf8');safe(audit);
    console.log('PASS public broker locked case: clear needs_you/1password in under 6.5s, no credentials in output/audit');
    }
  } finally {
    bridge?.destroy();for(const client of clients)client.destroy();
    const exited=once(broker,'close');broker.kill('SIGTERM');const timer=setTimeout(()=>broker.kill('SIGKILL'),5000);await exited;clearTimeout(timer);
    safe(diagnostics);
    for(const file of [output,output+'.other',output+'.delete',outsideOutput])if(fs.existsSync(file))fs.unlinkSync(file);
  }
}
