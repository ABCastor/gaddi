import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { waitParams, wheelParams, versionParam, hasErrorCode, isRecord } from '../../shared/protocol.ts';
import { createRecovery, RECOVERY_KEY } from '../../extension/recovery.ts';
import { waitFor } from './fake-daemon.ts';

const mutations: Record<string, [string, string, string]> = {
  OWN: ['bg', "{ window: 'own', show: 'attention' }", "{ window: 'shared', show: 'attention' }"],
  SECONDARY: ['windows', 'screens.find(screen => !screen.isPrimary && screen.isEnabled)', 'undefined'],
  ATTENTION: ['bg', "browser.show === 'front' ? { focused: true } : {}", "{ focused: true }"],
  SHARED: ['bg', 'if (params.browser) browser = params.browser;', 'void params.browser;'],
  RESTORE: ['windows', "if (typeof saved === 'number' && Number.isSafeInteger(saved)) { id = saved; return; }", 'if (typeof saved === "number") { id = 999999; return; }'],
  RELOAD: ['windows', 'record.targets.includes(target.id)', 'false'],
  RECYCLED: ['windows', 'record.targets.includes(target.id)', 'true'],
  RECREATE: ['windows', "if (existing?.type === 'normal') return id;", 'return id;'],
  DISPLAY_CHANGE: ['windows', "await chrome.windows.update(id, { state: 'minimized' });", 'void id;'],
  BLANK: ['windows', 'await chrome.tabs.remove(tab).catch(() => {});', 'void tab;'],
  RENDER: ['bg', '}, check, background, route);', '}, check, false, route);'],
  CLEANUP: ['bg', '!emulations.has(tab) && attached.get(tab) === session && session.owner === owner', 'false && attached.get(tab) === session && session.owner === owner'],
  OWNER: ['bg', '!current.active || !(await chrome.windows.get(current.windowId)).focused', 'true'],
  PAINT: ['bg', "if (background) await send('Runtime.evaluate', { expression:", "if (false) await send('Runtime.evaluate', { expression:"],
  BROKER_STOP: ['bg', '    stopRendering();', '    void 0;'],
};
const mutation = process.argv[2];
let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`PASS ASSERT_WINDOW_${name}`); }
  catch (error) { console.error(`FAIL ASSERT_WINDOW_${name}: ${String(error)}`); throw error; }
};
const event = () => {
  const listeners = new Set<(...args: any[]) => void>();
  return { addListener: (fn: (...args: any[]) => void) => listeners.add(fn), removeListener: (fn: (...args: any[]) => void) => listeners.delete(fn),
    emit: (...args: any[]) => { for (const fn of listeners) fn(...args); } };
};
const tabs = new Map<number, any>([[1, {id:1,windowId:1,active:true,index:0,title:'Owner',url:'http://localhost/'}]]);
const windows = new Map<number, any>([[1, {id:1,type:'normal',focused:true,left:0,top:0,width:1000,height:700}]]);
const groups = new Map<number, any>(), session: Record<string, unknown> = {}, replies = new Map<number, any>();
const local: Record<string, unknown> = {};
const windowCreates: any[] = [], windowUpdates: any[] = [], commands: any[] = [], rendering = new Map<number, boolean>();
let nextTab = 1, nextWindow = 1, nextGroup = 0, sequence = 0;
let releaseEval: ((value: unknown) => void) | undefined;
let screens = [
  { isPrimary:true,isEnabled:true,bounds:{left:0,top:0,width:1400,height:1000},workArea:{left:0,top:20,width:1400,height:980} },
  { isPrimary:false,isEnabled:true,bounds:{left:1400,top:0,width:1200,height:800},workArea:{left:1400,top:0,width:1200,height:800} },
];
const ports: any[] = [];
const chrome = {
  runtime: { onInstalled:event(),onStartup:event(),reload() {},connectNative: () => {
    const port = { onMessage:event(),onDisconnect:event(),postMessage: (message:any) => {
      if (message.method === 'bridge.health') queueMicrotask(() => port.onMessage.emit({id:message.id,method:'bridge.health',result:{connected:true}}));
      else replies.set(message.id,message);
    },disconnect() { this.onDisconnect.emit(); } };
    ports.push(port);return port;
  } },
  alarms: { onAlarm:event(),create() {} },
  storage: {
    local: { get: async()=>({...local}), set:async(value:any)=>Object.assign(local,value), remove:async(key:string)=>{delete local[key];} },
    session: { get:async()=>({...session}),set:async(value:any)=>Object.assign(session,value),remove:async(key:string)=>{delete session[key];} },
  },
  system: { display: { getInfo:async()=>screens,onDisplayChanged:event() } },
  windows: {
    onRemoved:event(),get:async(id:number)=>{if(!windows.has(id))throw new Error('Window closed');return {...windows.get(id)};},
    create:async(options:any)=>{
      windowCreates.push(options);const id=++nextWindow,tabId=++nextTab;
      const tab={id:tabId,windowId:id,active:true,index:0,title:'Blank',url:'about:blank'};
      tabs.set(tabId,tab);windows.set(id,{id,type:'normal',state:'normal',...options});return {...windows.get(id),tabs:[tab]};
    },
    update:async(id:number,options:any)=>{windowUpdates.push({id,...options});Object.assign(windows.get(id),options);return {...windows.get(id)};},
  },
  tabs: {
    onRemoved:event(),onUpdated:event(),get:async(id:number)=>{if(!tabs.has(id))throw new Error('Tab closed');return {...tabs.get(id)};},
    query:async(q:any)=>[...tabs.values()].filter(t=>(!q.active||t.active)&&(!q.lastFocusedWindow||windows.get(t.windowId).focused)&&(q.windowId===undefined||t.windowId===q.windowId)),
    create:async(options:any)=>{
      const id=++nextTab,windowId=options.windowId??1;
      const tab={id,windowId,index:0,active:false,title:'Agent',...options};tabs.set(id,tab);return {...tab};
    },
    remove:async(id:number)=>{
      const tab=tabs.get(id);if(!tab)throw new Error('Tab closed');tabs.delete(id);rendering.delete(id);chrome.tabs.onRemoved.emit(id);
      const remaining=[...tabs.values()].filter(t=>t.windowId===tab.windowId);
      if (!remaining.length) { windows.delete(tab.windowId);chrome.windows.onRemoved.emit(tab.windowId); }
      else if(tab.active)remaining[0].active=true;
    },
    update:async(id:number,options:any)=>{
      if(options.active)for(const tab of tabs.values())if(tab.windowId===tabs.get(id).windowId)tab.active=false;
      Object.assign(tabs.get(id),options);return {...tabs.get(id)};
    },
    move:async(id:number,options:any)=>{Object.assign(tabs.get(id),options);return {...tabs.get(id)};},
    group:async(options:any)=>{const id=options.groupId??++nextGroup;groups.set(id,groups.get(id)??{id,windowId:options.createProperties.windowId});for(const tab of options.tabIds)tabs.get(tab).groupId=id;return id;},
  },
  tabGroups: { query:async()=>[...groups.values()], update:async(id:number,options:any)=>Object.assign(groups.get(id),options) },
  scripting: { executeScript:async(options:any)=>[{result:options.args[0]==='read'?{text:'Page',outline:'',scroll:{y:0,height:1}}:{}}] },
  debugger: {
    getTargets:async()=>[...tabs.values()].map(tab=>({id:`target:${tab.id}`,tabId:tab.id})),
    onEvent:event(),onDetach:event(),attach:async()=>{},detach:async(target:any)=>{rendering.delete(target.tabId);},
    sendCommand:async(target:any,method:string,params:any)=>{
      commands.push({tab:target.tabId,method,params});
      if(method==='Emulation.setFocusEmulationEnabled')rendering.set(target.tabId,params.enabled);
      if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame',loaderId:'old',url:tabs.get(target.tabId).url}}};
      if(method==='Page.navigate'){
        const frame={id:'frame',loaderId:'new',url:params.url};tabs.get(target.tabId).url=params.url;
        chrome.debugger.onEvent.emit(target,'Page.frameNavigated',{frame});
        chrome.debugger.onEvent.emit(target,'Page.lifecycleEvent',{frameId:'frame',loaderId:'new',name:'DOMContentLoaded'});
        return {loaderId:'new'};
      }
      if(method==='Runtime.evaluate' && params.expression === 'blocked')return new Promise(resolve=>{releaseEval=resolve;});
      if(method==='Runtime.evaluate')return {result:{value:rendering.get(target.tabId)===true}};
      return {};
    },
  },
};
let bg = stripTypeScriptTypes(fs.readFileSync(new URL('../../extension/bg.ts',import.meta.url),'utf8')).replace(/^import .*;$/gm,'');
let windowSource = stripTypeScriptTypes(fs.readFileSync(new URL('../../extension/windows.ts',import.meta.url),'utf8')).replace(/^export /gm,'');
if(mutation) {
  assert.ok(mutations[mutation], `Unknown mutant ${mutation}`);
  const [file,before,after]=mutations[mutation];
  const source=file==='bg'?bg:windowSource;
  assert.equal(source.split(before).length,2,`Unique mutation ${mutation}`);
  if(file==='bg')bg=source.replace(before,after);else windowSource=source.replace(before,after);
}
const worlds: vm.Context[] = [];
const timers=new Set<ReturnType<typeof setTimeout>>();
function worker() {
  const world=vm.createContext({chrome,createRecovery,RECOVERY_KEY,waitParams,wheelParams,versionParam,hasErrorCode,isRecord,URL,
    pageTask() {},manageExtensions() {},setTimeout(fn:()=>void,ms:number){const timer=setTimeout(fn,ms);timers.add(timer);return timer;},clearTimeout});
  vm.runInContext(windowSource+'\n'+bg,world);worlds.push(world);return world;
}
async function call(method:string,params:object={}) {
  const id=++sequence;ports.at(-1).onMessage.emit({id,method,params});
  const reply=await waitFor(()=>replies.get(id),method);replies.delete(id);
  assert.equal(reply.error,undefined,reply.error?.message);return reply.result;
}
try {
  const world=worker();
  let opened:any;
  await test('OWN',async()=>{
    opened=await call('chrome.open',{url:'http://localhost/agent',group:'● Agent'});
    assert.notEqual(opened.windowId,1);assert.equal(tabs.get(1).active,true);assert.equal(windows.get(1).focused,true);
    assert.equal(windowCreates[0].focused,false);assert.equal(windows.get(opened.windowId).focused,false);
  });
  await test('SECONDARY',()=>{assert.equal(windowCreates[0].left,1400);assert.equal(windowCreates[0].width,1200);});
  await test('BLANK',()=>{assert.equal([...tabs.values()].filter(t=>t.windowId===opened.windowId).length,1);});
  await test('ATTENTION',async()=>{
    await call('chrome.show',{tab:opened.id});assert.deepEqual(windowUpdates.at(-1),{id:opened.windowId,drawAttention:true});
    assert.equal(windows.get(1).focused,true);assert.equal(windows.get(opened.windowId).focused,false);
  });
  await test('RENDER',async()=>{const reply=await call('chrome.eval',{tab:opened.id,expression:'document.visibilityState'});assert.equal(reply.value,true);});
  await test('CLEANUP',()=>{assert.notEqual(rendering.get(opened.id),true);assert.equal(vm.runInContext(`attached.has(${opened.id})`,world),false);});
  await test('PAINT',()=>{
    const evaluation=commands.findIndex(c=>c.tab===opened.id&&c.method==='Runtime.evaluate'&&c.params.expression==='document.visibilityState');
    assert.ok(commands.slice(0,evaluation).some(c=>c.tab===opened.id&&c.method==='Runtime.evaluate'&&c.params.expression.includes('requestAnimationFrame')));
  });
  await test('OWNER',async()=>{
    const at=commands.length;await call('chrome.eval',{tab:1,expression:'document.visibilityState'});
    assert.ok(!commands.slice(at).some(c=>c.method==='Emulation.setFocusEmulationEnabled'&&c.params.enabled));
  });
  await test('RESTORE',async()=>{
    const creates=windowCreates.length;worker();const again=await call('chrome.open',{url:'http://localhost/again',group:'● Again'});
    assert.equal(again.windowId,opened.windowId);assert.equal(windowCreates.length,creates);
  });
  await test('RELOAD',async()=>{
    delete session.agentWindow;const creates=windowCreates.length;worker();
    const restored=await call('chrome.open',{url:'http://localhost/reloaded',group:'● Reloaded'});
    assert.equal(restored.windowId,opened.windowId);assert.equal(windowCreates.length,creates);
  });
  await test('RECYCLED',async()=>{
    const remembered=structuredClone(local.agentWindowTargets);
    local.agentWindowTargets={id:1,targets:['a-target-from-an-old-browser']};delete session.agentWindow;
    const probe=vm.createContext({chrome});vm.runInContext(windowSource,probe);
    const windowId=await vm.runInContext('createAgentWindow().get(() => {})',probe);
    assert.notEqual(windowId,1);
    // Return the fixture to the original live window for the remaining journeys.
    session.agentWindow=opened.windowId;local.agentWindowTargets=remembered;
  });
  await test('DISPLAY_CHANGE',async()=>{
    Object.assign(windows.get(opened.windowId),{left:0,top:0});screens=screens.slice(0,1);chrome.system.display.onDisplayChanged.emit();
    await new Promise(r=>setTimeout(r,10));assert.equal(windows.get(opened.windowId).state,'minimized');
  });
  await test('SHARED',async()=>{
    const shared=await call('chrome.open',{url:'http://localhost/shared',group:'● Shared',browser:{window:'shared',show:'attention'}});
    assert.equal(shared.windowId,1);
    await call('chrome.show',{tab:shared.id,browser:{window:'shared',show:'front'}});
    assert.deepEqual(windowUpdates.at(-1),{id:1,focused:true,drawAttention:true});
  });
  await test('RECREATE',async()=>{
    // Chrome closes a window automatically when its final tab goes away.
    for(const tab of [...tabs.values()].filter(t=>t.windowId===opened.windowId))await call('chrome.close',{tabs:[tab.id]});
    await new Promise(r=>setTimeout(r,10));assert.equal(windows.has(opened.windowId),false);assert.equal(session.agentWindow,undefined);
    // A stale saved id must also be rejected, even without an onRemoved event.
    session.agentWindow=opened.windowId;worker();
    const recreated=await call('chrome.open',{url:'http://localhost/recreated',group:'● Recreated',browser:{window:'own',show:'attention'}});
    assert.notEqual(recreated.windowId,opened.windowId);assert.equal(windowCreates.at(-1).left,0);assert.equal(windowCreates.at(-1).focused,false);
    const grouped=await call('chrome.group',{tabs:[1],group:'● New group'});
    assert.equal(grouped.tabs[0].windowId,recreated.windowId);
  });
  await test('BROKER_STOP',async()=>{
    const target=[...tabs.values()].find(t=>t.windowId!==1);
    ports.at(-1).onMessage.emit({id:++sequence,method:'chrome.eval',params:{tab:target.id,expression:'blocked'}});
    await waitFor(()=>releaseEval,'evaluation held during rendering');
    assert.equal(rendering.get(target.id),true);ports.at(-1).onDisconnect.emit();
    await new Promise(r=>setTimeout(r,10));assert.equal(rendering.get(target.id),false);
    releaseEval!({result:{value:true}});
  });
  console.log(`== window lifecycle: ${passed} passed, 0 failed`);
} finally { for(const timer of timers)clearTimeout(timer); }
