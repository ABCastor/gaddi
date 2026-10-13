import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { waitParams, wheelParams, versionParam, hasErrorCode, isRecord } from '../../shared/protocol.ts';
import { createRecovery, RECOVERY_KEY } from '../../extension/recovery.ts';
import { waitFor } from './fake-daemon.ts';

const mutations: Record<string, [string, string, string]> = {
  OWN: ['bg', "{ window: 'own', show: 'attention' }", "{ window: 'shared', show: 'attention' }"],
  ATTENTION: ['bg', "browser.show === 'front' ? { focused: true } : {}", "{ focused: true }"],
  SHARED: ['bg', 'if (params.browser) browser = params.browser;', 'void params.browser;'],
  RESTORE: ['windows', "if (typeof saved === 'number' && Number.isSafeInteger(saved)) { id = saved; return; }", 'if (typeof saved === "number") { id = 999999; return; }'],
  RELOAD: ['windows', 'record.targets.includes(target.id)', 'false'],
  ADOPT: ['windows', 'return (await chrome.tabs.query({})).find(isPlaceholder)?.windowId;', 'return undefined;'],
  RECYCLED: ['windows', 'record.targets.includes(target.id)', 'true'],
  RECREATE: ['windows', "if (existing?.type === 'normal') {", 'if (true) {'],
  BLANK: ['windows', "type: 'normal', url: placeholderURL", "type: 'normal', url: 'about:blank'"],
  LIST: ['bg', '.filter(tab => !agentWindow.isPlaceholder(tab))', ''],
  PERSIST: ['bg', 'await chrome.tabs.remove(tab); closed.push(tab);', "await chrome.tabs.remove(tab); closed.push(tab); for (const candidate of await chrome.tabs.query({})) if (agentWindow.isPlaceholder(candidate)) await chrome.tabs.remove(candidate.id);"],
  CLOSE_PLACEHOLDER: ['bg', "if (agentWindow.isPlaceholder(await chrome.tabs.get(tab))) throw new Error('Gaddi placeholder is reserved');", 'void tab;'],
  MINIMIZED: ['windows', "state: 'minimized' }).then", "state: 'normal' }).then"],
  REPAIR: ['windows', 'if (!tabs.some(isPlaceholder))', 'if (false)'],
  EMPTY_RELOAD: ['windows', 'tabs.some(tab => tab.id === target.tabId)', 'tabs.some(tab => tab.id === target.tabId && !isPlaceholder(tab))'],
  RENDER: ['bg', '}, check, background, route);', '}, check, false, route);'],
  CLEANUP: ['bg', '!emulations.has(tab) && attached.get(tab) === session && session.owner === owner', 'false && attached.get(tab) === session && session.owner === owner'],
  OWNER: ['bg', '!current.active || !(await chrome.windows.get(current.windowId)).focused', 'true'],
  PAINT: ['bg', "if (background) await send('Runtime.evaluate', { expression:", "if (false) await send('Runtime.evaluate', { expression:"],
  BROKER_STOP: ['bg', '    stopRendering();', '    void 0;'],
};
const linkMutations: Record<string, [string, string, string]> = {
  OWNER_BOUNDS: ['windows', 'await keepAlive(check);', "await keepAlive(check); await chrome.windows.update(id!, { state: 'minimized' });"],
  CLEANUP_SCOPE: ['windows', 'old && !grouped.includes(tab.id!) && !groupingTabs.has(tab.id!) && (old.windowId !== tab.windowId || old.groupId !== tab.groupId || old.agentGroup && !agentGroup)', 'false'],
  CLEANUP_SHOWN: ['bg', 'await agentWindow.cleanupTabs(params.tab);', 'await agentWindow.cleanupTabs();'],
  SHOW_INTERRUPTED: ['bg', 'await agentWindow.cleanupTabs(params.tab);', 'await agentWindow.cleanupTabs();'],
  CLEANUP_FOCUS: ['windows', '!(tab.active && (await chrome.windows.get(tab.windowId)).focused)', 'true'],
  CLEANUP_AGENT: ['windows', 'tab.windowId === id || groups.some', 'true || groups.some'],
  CLEANUP_PLACEHOLDER: ['windows', '!isPlaceholder(tab) && (tab.windowId', '(tab.windowId'],
  OWNER_UNGROUP: ['windows', 'if (previous && previous.groupId !== change.groupId) void cleanupTabs(tab).catch(() => {});', 'void previous;'],
  AGENT_REGROUP: ['windows', 'change.groupId === undefined || groupingTabs.has(tab)', 'change.groupId === undefined'],
  CLEANUP_GROUPED: ['bg', 'if (!await agentWindow.isAgent(await getTab(id))) await agentWindow.cleanupTabs(id);', 'void id;'],
  CLEANUP_NO_TARGET: ['windows', 'currentAnchor ? `tab:${currentAnchor}:${tab.id}` : undefined', 'undefined'],
  CLEANUP_RESTART: ['windows', 'scopes = stored.scopes as Record<string, TabScope>;', 'scopes = {};'],
  CLEANUP_RECHECK: ['bg', '(await agentWindow.cleanupTabs()).find(candidate => candidate.id === tab)', 'eligible.find(candidate => candidate.id === tab)'],
  RELOAD_DISCARDED: ['bg', "current.discarded && browser.window === 'own' && await agentWindow.isAgent(current)", 'false'],
  RELOAD_READY: ['bg', "if (!current.discarded && current.status === 'complete') break;", 'break;'],
  EXTERNAL_LINK: ['windows', 'await chrome.tabs.move(tab.id, { windowId: owner.id, index: -1 });', 'void tab;'],
  EXTERNAL_FOCUS: ['windows', 'await chrome.windows.update(owner.id, { focused: true });', 'void owner;'],
  AGENT_CREATED: ['windows', 'createdTabs.has(tab.id)', 'false'],
  AGENT_POPUP: ['windows', 'opener && opener.windowId === id && !isPlaceholder(opener)', 'false'],
  NO_OWNER: ['windows', "{ tabId: tab.id, type: 'normal', focused: true }", "{ tabId: tab.id, type: 'normal', focused: false }"],
  SHARED_LINK: ['windows', "enabled = mode === 'own';", 'enabled = true;'],
  SHARED_RESTART: ['windows', "enabled = value[MODE_KEY] !== 'shared';", 'enabled = true;'],
  OWNER_FOCUS: ['windows', 'ownerId = window.id;', 'ownerId = 1;'],
  OWNER_IGNORE: ['windows', "window.type !== 'normal'", 'false'],
  OWNER_RESTART: ['windows', "if (typeof owner === 'number' && Number.isSafeInteger(owner)) ownerId = owner;", 'void owner;'],
  PLACEHOLDER_LINK: ['windows', 'current.windowId !== id || isPlaceholder(current)', 'current.windowId !== id'],
  CREATION_RACE: ['windows', 'await Promise.allSettled([...pendingCreates]);', 'void pendingCreates;'],
  CREATION_FOCUS: ['windows', 'await creatingWindow;', 'void creatingWindow;'],
};
const mutation = process.argv[2];
let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); passed++; console.log(`PASS ASSERT_WINDOW_${name}`); }
  catch (error) { console.error(`FAIL ASSERT_WINDOW_${name}: ${String(error)}`); throw error; }
};
const event = () => {
  const listeners = new Set<(...args: any[]) => void>();
  return { listeners, addListener: (fn: (...args: any[]) => void) => listeners.add(fn), removeListener: (fn: (...args: any[]) => void) => listeners.delete(fn),
    emit: (...args: any[]) => { for (const fn of listeners) fn(...args); } };
};
const tabs = new Map<number, any>([[1, {id:1,windowId:1,active:true,index:0,title:'Owner',url:'http://localhost/'}]]);
const windows = new Map<number, any>([[1, {id:1,type:'normal',focused:true,left:0,top:0,width:1000,height:700}]]);
const groups = new Map<number, any>(), session: Record<string, unknown> = {}, replies = new Map<number, any>();
const local: Record<string, unknown> = {};
const windowCreates: any[] = [], windowUpdates: any[] = [], commands: any[] = [], rendering = new Map<number, boolean>();
let nextTab = 1, nextWindow = 1, nextGroup = 0, sequence = 0;
let failNavigation = false;
let holdCreation = false, releaseCreation: (() => void) | undefined;
let holdWindowCreation = false, releaseWindowCreation: (() => void) | undefined;
let releaseEval: ((value: unknown) => void) | undefined;
const ports: any[] = [];
const chrome = {
  runtime: { getURL:(path:string)=>`chrome-extension://gaddi/${path}`,onInstalled:event(),onStartup:event(),reload() {},connectNative: () => {
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
  windows: {
    WINDOW_ID_NONE:-1,onFocusChanged:event(),onRemoved:event(),get:async(id:number)=>{if(!windows.has(id))throw new Error('Window closed');return {...windows.get(id)};},
    getAll:async(q:any)=>[...windows.values()].filter(w=>!q.windowTypes||q.windowTypes.includes(w.type)).map(w=>({...w})),
    getLastFocused:async()=>({...([...windows.values()].find(w=>w.focused)??windows.values().next().value)}),
    create:async(options:any)=>{
      if(options.state==='minimized')assert.ok(!['left','top','width','height'].some(key=>key in options));
      windowCreates.push(options);const id=++nextWindow,tabId=options.tabId??++nextTab;
      const tab=options.tabId!==undefined?tabs.get(tabId):{id:tabId,active:true,index:0,title:'Gaddi',url:options.url};
      Object.assign(tab,{windowId:id,active:true});tabs.set(tabId,tab);windows.set(id,{id,type:'normal',state:'normal',...options});
      if(options.focused)for(const w of windows.values())w.focused=w.id===id;
      if(options.tabId===undefined)chrome.tabs.onCreated.emit({...tab});
      if(holdWindowCreation&&options.url) {
        chrome.windows.onFocusChanged.emit(id);
        await new Promise<void>(resolve=>{releaseWindowCreation=resolve;});
      }
      return {...windows.get(id),tabs:[{...tab}]};
    },
    update:async(id:number,options:any)=>{windowUpdates.push({id,...options});if(options.focused)for(const w of windows.values())w.focused=w.id===id;Object.assign(windows.get(id),options);return {...windows.get(id)};},
  },
  tabs: {
    onCreated:event(),onRemoved:event(),onUpdated:event(),onDetached:event(),get:async(id:number)=>{if(!tabs.has(id))throw new Error('Tab closed');return {...tabs.get(id)};},
    query:async(q:any)=>[...tabs.values()].filter(t=>(!q.active||t.active)&&(!q.lastFocusedWindow||windows.get(t.windowId).focused)&&(q.windowId===undefined||t.windowId===q.windowId)),
    create:async(options:any)=>{
      const id=++nextTab,windowId=options.windowId??1;
      const tab={id,windowId,index:0,active:false,title:'Agent',...options};tabs.set(id,tab);chrome.tabs.onCreated.emit({...tab});
      if(holdCreation&&options.url==='about:blank')await new Promise<void>(resolve=>{releaseCreation=resolve;});
      return {...tab};
    },
    reload:async(id:number)=>{
      Object.assign(tabs.get(id),{discarded:false,status:'loading'});
      setTimeout(()=>{tabs.get(id).status='complete';chrome.tabs.onUpdated.emit(id,{status:'complete'});},20);
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
    group:async(options:any)=>{const id=options.groupId??++nextGroup;groups.set(id,groups.get(id)??{id,windowId:options.createProperties.windowId});for(const tab of options.tabIds){tabs.get(tab).groupId=id;chrome.tabs.onUpdated.emit(tab,{groupId:id});}return id;},
  },
  tabGroups: { onUpdated:event(),query:async()=>[...groups.values()], update:async(id:number,options:any)=>{Object.assign(groups.get(id),options);chrome.tabGroups.onUpdated.emit({...groups.get(id)});return groups.get(id);} },
  scripting: { executeScript:async(options:any)=>[{result:options.args[0]==='read'?{text:'Page',outline:'',scroll:{y:0,height:1}}:{}}] },
  debugger: {
    getTargets:async()=>[...tabs.values()].map(tab=>({id:`target:${tab.id}`,tabId:tab.id})),
    onEvent:event(),onDetach:event(),attach:async()=>{},detach:async(target:any)=>{rendering.delete(target.tabId);},
    sendCommand:async(target:any,method:string,params:any)=>{
      if(method==='Runtime.evaluate'&&params.expression==='1')assert.notEqual(tabs.get(target.tabId)?.status,'loading','discarded renderer must finish reload before action');
      commands.push({tab:target.tabId,method,params});
      if(method==='Emulation.setFocusEmulationEnabled')rendering.set(target.tabId,params.enabled);
      if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'frame',loaderId:'old',url:tabs.get(target.tabId).url}}};
      if(method==='Page.navigate'){
        if(failNavigation)return {errorText:'net::ERR_CONNECTION_REFUSED'};
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
let windowSource = fs.readFileSync(new URL('../../extension/windows.ts',import.meta.url),'utf8').replace(/^export /gm,'');
const linkWindowSource = windowSource;
if(mutation && mutations[mutation]) {
  const [file,before,after]=mutations[mutation];
  const source=file==='bg'?bg:windowSource;
  assert.equal(source.split(before).length,2,`Unique mutation ${mutation}`);
  if(file==='bg')bg=source.replace(before,after);else windowSource=source.replace(before,after);
}
assert.ok(!mutation || mutations[mutation] || linkMutations[mutation], `Unknown mutant ${mutation}`);
windowSource = stripTypeScriptTypes(windowSource);
const worlds: vm.Context[] = [];
const timers=new Set<ReturnType<typeof setTimeout>>();
const lifecycleEvents = [chrome.windows.onRemoved,chrome.windows.onFocusChanged,chrome.tabs.onCreated,chrome.tabs.onRemoved,chrome.tabs.onDetached,chrome.tabs.onUpdated,chrome.tabGroups.onUpdated];
function worker() {
  for(const timer of timers)clearTimeout(timer);
  timers.clear();
  // A restarted service worker loses its listeners; the fake must do the same.
  for(const event of lifecycleEvents)event.listeners.clear();
  const world=vm.createContext({chrome,createRecovery,RECOVERY_KEY,waitParams,wheelParams,versionParam,hasErrorCode,isRecord,URL,
    pageTask() {},manageExtensions() {},setTimeout(fn:()=>void,ms:number){const timer=setTimeout(fn,ms);timers.add(timer);return timer;},clearTimeout});
  vm.runInContext(windowSource+'\n'+bg,world);worlds.push(world);return world;
}
async function rawCall(method:string,params:object={}) {
  const id=++sequence;ports.at(-1).onMessage.emit({id,method,params});
  const reply=await waitFor(()=>replies.get(id),method);replies.delete(id);
  return reply;
}
async function call(method:string,params:object={}) {
  const reply=await rawCall(method,params);
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
  await test('MINIMIZED',async()=>{
    const options=windowCreates[0];
    assert.equal(options.state,'minimized');assert.equal(options.focused,false);
    for(const key of ['left','top','width','height'])assert.ok(!(key in options));
    const count=windowUpdates.length;
    for(let n=0;n<2;n++) {
      const next=await call('chrome.open',{url:`http://localhost/minimized-${n}`,group:'● Minimized'});
      assert.equal(next.windowId,opened.windowId);
    }
    assert.equal(windows.get(opened.windowId).state,'minimized');
    assert.equal(windowCreates.length,1);assert.equal(windowUpdates.length,count);
    for(const tab of [...tabs.values()].filter(t=>t.url.startsWith('http://localhost/minimized-')))await chrome.tabs.remove(tab.id);
  });
  await test('BLANK',()=>{
    const own=[...tabs.values()].filter(t=>t.windowId===opened.windowId);
    assert.equal(own.length,2);assert.equal(own.filter(t=>t.url==='chrome-extension://gaddi/placeholder.html').length,1);
  });
  await test('LIST',async()=>{
    const listed=await call('chrome.tabs');assert.equal(listed.tabs.length,2);
    assert.ok(listed.tabs.some((t:any)=>t.id===1));assert.ok(listed.tabs.some((t:any)=>t.id===opened.id));
    assert.ok(!listed.tabs.some((t:any)=>t.url==='chrome-extension://gaddi/placeholder.html'));
  });
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
  await test('PERSIST',async()=>{
    const creates=windowCreates.length;await call('chrome.close',{tabs:[opened.id]});
    assert.equal(windows.has(opened.windowId),true);
    assert.equal([...tabs.values()].filter(t=>t.windowId===opened.windowId).length,1);
    const next=await call('chrome.open',{url:'http://localhost/next',group:'● Next'});
    assert.equal(next.windowId,opened.windowId);assert.equal(windowCreates.length,creates);
    opened=next;
  });
  await test('CLOSE_PLACEHOLDER',async()=>{
    const placeholder=[...tabs.values()].find(t=>t.windowId===opened.windowId&&t.url==='chrome-extension://gaddi/placeholder.html');
    const result=await call('chrome.close',{tabs:[placeholder.id]});
    assert.equal(result.closed.length,0);assert.equal(result.failed[0].tab,placeholder.id);assert.equal(tabs.has(placeholder.id),true);
  });
  await test('RESTORE',async()=>{
    const creates=windowCreates.length;worker();const again=await call('chrome.open',{url:'http://localhost/again',group:'● Again'});
    assert.equal(again.windowId,opened.windowId);assert.equal(windowCreates.length,creates);
  });
  await test('ADOPT',async()=>{
    const remembered=structuredClone(local.agentWindowTargets);delete local.agentWindowTargets;
    delete session.agentWindow;const creates=windowCreates.length;worker();
    const adopted=await call('chrome.open',{url:'http://localhost/adopted',group:'● Adopted'});
    assert.equal(adopted.windowId,opened.windowId);assert.equal(windowCreates.length,creates);
    local.agentWindowTargets=remembered;
  });
  await test('RELOAD',async()=>{
    // Without the placeholder, recovery falls back to the remembered page targets.
    const placeholder=[...tabs.values()].find(t=>t.windowId===opened.windowId&&t.url==='chrome-extension://gaddi/placeholder.html');
    if(placeholder)tabs.delete(placeholder.id);
    delete session.agentWindow;const creates=windowCreates.length;worker();
    const restored=await call('chrome.open',{url:'http://localhost/reloaded',group:'● Reloaded'});
    assert.equal(restored.windowId,opened.windowId);assert.equal(windowCreates.length,creates);
  });
  await test('RECYCLED',async()=>{
    const listeners=lifecycleEvents.map(event=>[...event.listeners]);
    const remembered=structuredClone(local.agentWindowTargets);
    local.agentWindowTargets={id:1,targets:['a-target-from-an-old-browser']};delete session.agentWindow;
    // Hide the placeholder so this checks the remembered-target path alone.
    const placeholder=[...tabs.values()].find(t=>t.url==='chrome-extension://gaddi/placeholder.html');if(placeholder)tabs.delete(placeholder.id);
    const probe=vm.createContext({chrome});vm.runInContext(windowSource,probe);
    const windowId=await vm.runInContext('createAgentWindow().get(() => {})',probe);
    assert.notEqual(windowId,1);
    for(const [key,tab] of tabs)if(tab.windowId===windowId)tabs.delete(key);windows.delete(windowId);
    // Return the fixture to the original live window for the remaining journeys.
    session.agentWindow=opened.windowId;local.agentWindowTargets=remembered;if(placeholder)tabs.set(placeholder.id,placeholder);
    lifecycleEvents.forEach((event,i)=>{event.listeners.clear();for(const listener of listeners[i])event.listeners.add(listener);});
  });
  await test('SHARED',async()=>{
    const shared=await call('chrome.open',{url:'http://localhost/shared',group:'● Shared',browser:{window:'shared',show:'attention'}});
    assert.equal(shared.windowId,1);
    await call('chrome.show',{tab:shared.id,browser:{window:'shared',show:'front'}});
    assert.deepEqual(windowUpdates.at(-1),{id:1,focused:true,drawAttention:true});
  });
  await test('RECREATE',async()=>{
    // Chrome closes a window automatically when its final tab goes away.
    for(const tab of [...tabs.values()].filter(t=>t.windowId===opened.windowId))await chrome.tabs.remove(tab.id);
    await new Promise(r=>setTimeout(r,10));assert.equal(windows.has(opened.windowId),false);assert.equal(session.agentWindow,undefined);
    // A stale saved id must also be rejected, even without an onRemoved event.
    session.agentWindow=opened.windowId;worker();
    const recreated=await call('chrome.open',{url:'http://localhost/recreated',group:'● Recreated',browser:{window:'own',show:'attention'}});
    assert.notEqual(recreated.windowId,opened.windowId);assert.equal(windowCreates.at(-1).left,undefined);assert.equal(windowCreates.at(-1).focused,false);
    const grouped=await call('chrome.group',{tabs:[1],group:'● New group'});
    assert.equal(grouped.tabs[0].windowId,recreated.windowId);
  });
  await test('REPAIR',async()=>{
    const id=session.agentWindow;const placeholder=[...tabs.values()].find(t=>t.windowId===id&&t.url==='chrome-extension://gaddi/placeholder.html');
    await chrome.tabs.remove(placeholder.id);
    await call('chrome.open',{url:'http://localhost/repair',group:'● Repair'});
    assert.equal([...tabs.values()].filter(t=>t.windowId===id&&t.url==='chrome-extension://gaddi/placeholder.html').length,1);
  });
  await test('FAILED_OPEN',async()=>{
    const id=session.agentWindow;
    for(const tab of [...tabs.values()].filter(t=>t.windowId===id))await chrome.tabs.remove(tab.id);
    await new Promise(r=>setTimeout(r,10));failNavigation=true;
    const reply=await rawCall('chrome.open',{url:'http://localhost/fail',group:'● Fail'});failNavigation=false;
    assert.ok(reply.error);assert.match(reply.error.message,/ERR_CONNECTION_REFUSED/);
    assert.equal([...tabs.values()].filter(t=>t.windowId===session.agentWindow).length,1);
    await call('chrome.open',{url:'http://localhost/ready',group:'● Ready'});
  });
  await test('EMPTY_RELOAD',async()=>{
    const id=session.agentWindow;const creates=windowCreates.length;
    const owned=[...tabs.values()].filter(t=>t.windowId===id&&!t.url.startsWith('chrome-extension:')).map(t=>t.id);
    await call('chrome.close',{tabs:owned});
    assert.equal([...tabs.values()].filter(t=>t.windowId===id).length,1);
    delete session.agentWindow;worker();
    const next=await call('chrome.open',{url:'http://localhost/empty-reload',group:'● Empty reload'});
    assert.equal(next.windowId,id);assert.equal(windowCreates.length,creates);
  });
  await test('BROKER_STOP',async()=>{
    const target=[...tabs.values()].find(t=>t.windowId!==1&&!t.url.startsWith('chrome-extension:'));
    ports.at(-1).onMessage.emit({id:++sequence,method:'chrome.eval',params:{tab:target.id,expression:'blocked'}});
    await waitFor(()=>releaseEval,'evaluation held during rendering');
    assert.equal(rendering.get(target.id),true);ports.at(-1).onDisconnect.emit();
    await new Promise(r=>setTimeout(r,10));assert.equal(rendering.get(target.id),false);
    releaseEval!({result:{value:true}});
  });
  // Apply link mutants only to the following isolated journeys so each breach
  // must fail its own assertion rather than an earlier lifecycle assertion.
  let links = linkWindowSource;
  if(mutation && linkMutations[mutation]) {
    const [file,before,after]=linkMutations[mutation];
    const source=file==='bg'?bg:links;
    assert.equal(source.split(before).length,2,`Unique mutation ${mutation}`);
    if(file==='bg')bg=source.replace(before,after);else links=source.replace(before,after);
  }
  windowSource=stripTypeScriptTypes(links);
  async function fixture(focusCreation=false) {
    tabs.clear();windows.clear();groups.clear();
    for(const key of Object.keys(session))delete session[key];
    for(const key of Object.keys(local))delete local[key];
    tabs.set(1,{id:1,windowId:1,active:true,index:0,title:'Owner',url:'http://localhost/'});
    windows.set(1,{id:1,type:'normal',focused:true,left:0,top:0,width:1000,height:700});
    nextTab=1;nextWindow=1;holdCreation=false;releaseCreation=undefined;
    holdWindowCreation=focusCreation;releaseWindowCreation=undefined;
    worker();
    const opening=call('chrome.open',{url:'http://localhost/agent-link',group:'● Links'});
    if(focusCreation) {
      await waitFor(()=>releaseWindowCreation,'Gaddi window creation response held');await settle();
      assert.equal(session.ownerWindow,1);releaseWindowCreation!();holdWindowCreation=false;
    }
    const agent=await opening;
    await settle();
    return agent;
  }
  const settle=()=>new Promise(r=>setTimeout(r,20));
  function ownerWindow(type='normal') {
    const id=++nextWindow;windows.set(id,{id,type,focused:false,state:'normal'});return id;
  }
  function external(windowId:number,openerTabId?:number,url='https://external.test/') {
    const id=++nextTab;
    tabs.set(id,{id,windowId,active:false,index:0,url,...(openerTabId!==undefined?{openerTabId}:{})});
    // Creation may arrive without URL or group metadata, as Chrome documents.
    chrome.tabs.onCreated.emit({id,windowId,active:false,index:0,...(openerTabId!==undefined?{openerTabId}:{})});
    return id;
  }
  const linkTest=async(name:string,fn:()=>Promise<void>)=>{
    if(mutation && linkMutations[mutation] && mutation!==name)return;
    await test(name,fn);
  };
  await linkTest('OWNER_BOUNDS',async()=>{
    const opened=await fixture();
    for (const state of ['normal','maximized','minimized']) {
      Object.assign(windows.get(opened.windowId),{left:0,top:55,width:800,height:600,state});
      const before=structuredClone(windows.get(opened.windowId)), count=windowUpdates.length;
      await call('chrome.open',{url:'http://localhost/owner-bounds',group:'● Owner bounds'});
      assert.deepEqual(windows.get(opened.windowId),before);assert.equal(windowUpdates.length,count);
    }
    // A worker reload retains the owner's expanded placement.
    windows.get(opened.windowId).state='maximized';worker();
    await call('chrome.open',{url:'http://localhost/owner-reload',group:'● Owner reload'});
    assert.equal(windows.get(opened.windowId).state,'maximized');
  });
  await linkTest('CLEANUP_SCOPE',async()=>{
    const agent=await fixture();
    const eligible=await call('chrome.cleanup');assert.ok(eligible.tabs.some((tab:any)=>tab.id===agent.id));
    // Moving out of a group inside Gaddi's window is still an owner takeover.
    delete tabs.get(agent.id).groupId;
    assert.ok(!(await call('chrome.cleanup')).tabs.some((tab:any)=>tab.id===agent.id));
    // Returning to an agent group cannot undo the handoff.
    tabs.get(agent.id).groupId=[...groups.keys()][0];
    assert.ok(!(await call('chrome.cleanup')).tabs.some((tab:any)=>tab.id===agent.id));
    const other=await call('chrome.open',{url:'http://localhost/moved-out',group:'● Out'});
    tabs.get(other.id).windowId=1;
    assert.ok(!(await call('chrome.cleanup')).tabs.some((tab:any)=>tab.id===other.id));
  });
  await linkTest('CLEANUP_SHOWN',async()=>{
    const agent=await fixture();await call('chrome.show',{tab:agent.id});
    const result=await call('chrome.cleanup',{tabs:[agent.id],cleanup:'close'});
    assert.equal(result.closed.length,0);assert.ok(tabs.has(agent.id));
  });
  await linkTest('SHOW_INTERRUPTED',async()=>{
    const agent=await fixture();const update=chrome.windows.update;
    chrome.windows.update=async(id:number,options:any)=>{
      if(options.drawAttention)throw new Error('Attention failed after tab activation');
      return update(id,options);
    };
    try {
      const reply=await rawCall('chrome.show',{tab:agent.id});assert.ok(reply.error);
      assert.equal(tabs.get(agent.id).active,true);
    } finally {chrome.windows.update=update;}
    worker();assert.ok(!(await call('chrome.cleanup')).tabs.some((tab:any)=>tab.id===agent.id));
  });
  await linkTest('CLEANUP_FOCUS',async()=>{
    const agent=await fixture();tabs.get(agent.id).active=true;windows.get(agent.windowId).focused=true;
    assert.equal((await call('chrome.cleanup',{tabs:[agent.id],cleanup:'close'})).closed.length,0);
    assert.ok(tabs.has(agent.id));
  });
  await linkTest('CLEANUP_AGENT',async()=>{
    await fixture();tabs.get(1).active=false;
    assert.ok(!(await call('chrome.cleanup')).tabs.some((tab:any)=>tab.id===1));
    const result=await call('chrome.cleanup',{tabs:[1],cleanup:'close'});
    assert.equal(result.closed.length,0);assert.ok(tabs.has(1));
    // Agent markers in the owner's other windows are recognisable orphans too.
    const marked=++nextTab;tabs.set(marked,{id:marked,windowId:1,active:false,groupId:++nextGroup,url:'http://localhost/orphan'});
    groups.set(nextGroup,{id:nextGroup,windowId:1,title:'● Orphan'});
    assert.ok((await call('chrome.cleanup')).tabs.some((tab:any)=>tab.id===marked));
  });
  await linkTest('CLEANUP_PLACEHOLDER',async()=>{
    const agent=await fixture();const placeholder=[...tabs.values()].find(tab=>tab.windowId===agent.windowId&&tab.url.endsWith('placeholder.html'));
    assert.equal((await call('chrome.cleanup',{tabs:[placeholder.id],cleanup:'close'})).closed.length,0);
    assert.ok(tabs.has(placeholder.id));
  });
  await linkTest('OWNER_UNGROUP',async()=>{
    const agent=await fixture();const groupId=tabs.get(agent.id).groupId;
    tabs.get(agent.id).groupId=-1;chrome.tabs.onUpdated.emit(agent.id,{groupId:-1});
    // The user returns it before the next sweep; the handoff remains sticky.
    tabs.get(agent.id).groupId=groupId;
    await settle();assert.ok(!(await call('chrome.cleanup')).tabs.some((tab:any)=>tab.id===agent.id));
  });
  await linkTest('AGENT_REGROUP',async()=>{
    const agent=await fixture();await call('chrome.group',{tabs:[agent.id],group:'● Agent regroup'});
    await settle();assert.ok((await call('chrome.cleanup')).tabs.some((tab:any)=>tab.id===agent.id));
  });
  await linkTest('CLEANUP_GROUPED',async()=>{
    await fixture();await call('chrome.group',{tabs:[1],group:'● Owner grouped'});
    assert.ok(!(await call('chrome.cleanup')).tabs.some((tab:any)=>tab.id===1));
  });
  await linkTest('CLEANUP_NO_TARGET',async()=>{
    const agent=await fixture();tabs.get(agent.id).discarded=true;
    const legacy=++nextTab;tabs.set(legacy,{id:legacy,windowId:agent.windowId,active:false,discarded:true,url:'http://localhost/legacy'});
    const getTargets=chrome.debugger.getTargets;
    chrome.debugger.getTargets=async()=> (await getTargets()).filter(target=>target.tabId!==agent.id&&target.tabId!==legacy);
    try {
      worker();const candidates=(await call('chrome.cleanup')).tabs;assert.ok(candidates.some((tab:any)=>tab.id===agent.id));assert.ok(candidates.some((tab:any)=>tab.id===legacy));
      assert.equal((await call('chrome.cleanup',{tabs:[agent.id],cleanup:'close'})).closed.join(','),String(agent.id));
    } finally {chrome.debugger.getTargets=getTargets;}
  });
  await linkTest('CLEANUP_RESTART',async()=>{
    const agent=await fixture();await call('chrome.show',{tab:agent.id});
    const moved=await call('chrome.open',{url:'http://localhost/owner',group:'● Owner'});
    tabs.get(moved.id).windowId=1;await call('chrome.cleanup');
    // Extension reload loses session storage, while page-target identities survive.
    for(const key of Object.keys(session))delete session[key];worker();
    assert.ok(!(await call('chrome.cleanup')).tabs.some((tab:any)=>tab.id===agent.id||tab.id===moved.id));
  });
  await linkTest('CLEANUP_RECHECK',async()=>{
    const agent=await fixture();tabs.get(agent.id).active=true;
    const get=chrome.windows.get;let checks=0;
    chrome.windows.get=async(id:number)=>{
      const result=await get(id);
      if(id===agent.windowId&&++checks===1)windows.get(id).focused=true;
      return result;
    };
    try { assert.equal((await call('chrome.cleanup',{tabs:[agent.id],cleanup:'close'})).closed.length,0);assert.ok(tabs.has(agent.id)); }
    finally {chrome.windows.get=get;}
  });
  await linkTest('RELOAD_DISCARDED',async()=>{
    const agent=await fixture();
    // Chrome may discard a tab independently of Gaddi.
    tabs.get(agent.id).discarded=true;
    assert.equal(tabs.get(agent.id).discarded,true);
    const before=windowUpdates.length;await call('chrome.eval',{tab:agent.id,expression:'1'});
    assert.equal(tabs.get(agent.id).discarded,false);assert.equal(windowUpdates.length,before);
    tabs.get(agent.id).discarded=true;
    assert.equal((await call('chrome.cleanup',{tabs:[agent.id],cleanup:'close'})).closed.join(','),String(agent.id));
  });
  await linkTest('RELOAD_READY',async()=>{
    const agent=await fixture();tabs.get(agent.id).discarded=true;
    await call('chrome.eval',{tab:agent.id,expression:'1'});assert.equal(tabs.get(agent.id).status,'complete');
  });
  await linkTest('EXTERNAL_LINK',async()=>{
    const agent=await fixture();
    const link=external(agent.windowId);await settle();
    assert.equal(tabs.get(link).windowId,1);assert.equal(tabs.get(link).active,true);
    assert.equal(tabs.get(agent.id).windowId,agent.windowId);
    // A new tab already in an owner window is left alone.
    const outside=external(1);await settle();assert.equal(tabs.get(outside).active,false);
    const ownerPopup=external(agent.windowId,1);await settle();assert.equal(tabs.get(ownerPopup).windowId,1);
  });
  await linkTest('LINK_AFTER_RELOAD',async()=>{
    // An extension reload forgets the window id; the placeholder still marks the Gaddi window.
    const agent=await fixture();delete session.agentWindow;delete local.agentWindowTargets;worker();
    const link=external(agent.windowId);await settle();
    assert.equal(tabs.get(link).windowId,1);assert.equal(tabs.get(link).active,true);
  });
  await linkTest('EXTERNAL_FOCUS',async()=>{
    const agent=await fixture();windows.get(1).focused=false;windows.get(agent.windowId).focused=true;
    const link=external(agent.windowId);await settle();
    assert.equal(tabs.get(link).windowId,1);assert.equal(windows.get(1).focused,true);
    assert.equal(windows.get(agent.windowId).focused,false);
  });
  await linkTest('AGENT_CREATED',async()=>{
    const agent=await fixture();await settle();
    assert.equal(tabs.get(agent.id).windowId,session.agentWindow);assert.equal(agent.windowId,session.agentWindow);
    assert.equal(tabs.get(agent.id).active,false);
  });
  await linkTest('AGENT_POPUP',async()=>{
    const agent=await fixture();
    const popup=external(agent.windowId,agent.id);await settle();
    assert.equal(tabs.get(popup).windowId,agent.windowId);assert.equal(tabs.get(popup).active,false);
    worker();await settle();
    const afterRestart=external(agent.windowId,popup);await settle();
    assert.equal(tabs.get(afterRestart).windowId,agent.windowId);
  });
  await linkTest('NO_OWNER',async()=>{
    const agent=await fixture();windows.delete(1);tabs.delete(1);ownerWindow('popup');
    const before=windowCreates.length,link=external(agent.windowId);await settle();
    const owner=windows.get(tabs.get(link).windowId);
    assert.notEqual(owner.id,agent.windowId);assert.equal(owner.type,'normal');assert.equal(owner.focused,true);
    assert.equal(tabs.get(link).active,true);assert.equal(windowCreates.length,before+1);
    assert.equal(windowCreates.at(-1).tabId,link);assert.equal(session.ownerWindow,owner.id);
  });
  await linkTest('SHARED_LINK',async()=>{
    const agent=await fixture();
    await call('chrome.tabs',{browser:{window:'shared',show:'attention'}});
    const owner=ownerWindow();chrome.windows.onFocusChanged.emit(owner);
    const link=external(agent.windowId),before=windowUpdates.length;await settle();
    assert.equal(tabs.get(link).windowId,agent.windowId);assert.equal(tabs.get(link).active,false);
    assert.equal(windowUpdates.length,before);assert.equal(session.ownerWindow,1);
  });
  await linkTest('OWNER_FOCUS',async()=>{
    const agent=await fixture();const owner=ownerWindow();
    chrome.windows.onFocusChanged.emit(1);chrome.windows.onFocusChanged.emit(owner);await settle();
    const link=external(agent.windowId);await settle();
    assert.equal(session.ownerWindow,owner);assert.equal(tabs.get(link).windowId,owner);
  });
  await linkTest('SHARED_RESTART',async()=>{
    const agent=await fixture();
    await call('chrome.tabs',{browser:{window:'shared',show:'attention'}});
    worker();
    const owner=ownerWindow();chrome.windows.onFocusChanged.emit(owner);
    const link=external(agent.windowId);await settle();
    assert.equal(tabs.get(link).windowId,agent.windowId);assert.equal(session.ownerWindow,1);
  });
  await linkTest('OWNER_IGNORE',async()=>{
    const agent=await fixture();const owner=ownerWindow();
    chrome.windows.onFocusChanged.emit(owner);await settle();
    chrome.windows.onFocusChanged.emit(chrome.windows.WINDOW_ID_NONE);
    chrome.windows.onFocusChanged.emit(agent.windowId);
    chrome.windows.onFocusChanged.emit(ownerWindow('popup'));await settle();
    assert.equal(session.ownerWindow,owner);
    const link=external(agent.windowId);await settle();assert.equal(tabs.get(link).windowId,owner);
  });
  await linkTest('OWNER_RESTART',async()=>{
    const agent=await fixture();const owner=ownerWindow();chrome.windows.onFocusChanged.emit(owner);await settle();
    windows.get(1).focused=false;windows.get(agent.windowId).focused=true;
    worker();const link=external(agent.windowId);await settle();
    assert.equal(tabs.get(link).windowId,owner);assert.equal(windows.get(owner).focused,true);
  });
  await linkTest('PLACEHOLDER_LINK',async()=>{
    const agent=await fixture();worker();await settle();
    const placeholder=[...tabs.values()].find(t=>t.windowId===agent.windowId&&t.url.startsWith('chrome-extension:'));
    chrome.tabs.onCreated.emit({id:placeholder.id,windowId:agent.windowId,active:true,index:0});await settle();
    assert.equal(tabs.get(placeholder.id).windowId,agent.windowId);
  });
  await linkTest('CREATION_RACE',async()=>{
    const agent=await fixture();holdCreation=true;
    const opening=call('chrome.open',{url:'http://localhost/racing-agent',group:'● Race'});
    await waitFor(()=>releaseCreation,'agent creation response held');const pendingId=nextTab;
    const link=external(agent.windowId);await settle();
    assert.equal(tabs.get(pendingId).windowId,agent.windowId);
    releaseCreation!();await opening;await settle();holdCreation=false;
    assert.equal(tabs.get(pendingId).windowId,agent.windowId);assert.equal(tabs.get(link).windowId,1);
  });
  await linkTest('CREATION_FOCUS',async()=>{
    const agent=await fixture(true);assert.equal(session.ownerWindow,1);
    const link=external(agent.windowId);await settle();assert.equal(tabs.get(link).windowId,1);
  });
  console.log(`== window lifecycle: ${passed} passed, 0 failed`);
} finally { for(const timer of timers)clearTimeout(timer); }
