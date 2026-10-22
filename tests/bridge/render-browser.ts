// Native visibility and animation measurements in a disposable, headless Chrome.
// A Playwright launch turns on focus emulation for every page, which keeps every
// background tab visible and drawing. Chrome is started here and attached with
// noDefaults so the extension is the only client that changes page state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chromium } from 'playwright-core';
import type { BrowserContext } from 'playwright-core';
import { FakeDaemon, waitFor } from './fake-daemon.ts';
import { callsFor } from './extension-types.ts';
import { requireHeadless } from './background.ts';

const repo = path.resolve(import.meta.dirname, '../..');
const bin = path.join(os.homedir(), 'Library/Application Support/Gaddi/bin');
const candidates = fs.existsSync(bin) ? fs.readdirSync(bin, {recursive:true,encoding:'utf8'}).filter(n=>n.endsWith('Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')).sort() : [];
const executablePath = process.env.GADDI_CHROME ?? (candidates.at(-1) && path.join(bin,candidates.at(-1)!));
if (!executablePath) { console.log('SKIP background rendering: Chrome for Testing unavailable'); process.exit(77); }
assert.ok(fs.realpathSync(executablePath).startsWith(fs.realpathSync(bin)+path.sep));
assert.match(executablePath,/Google Chrome for Testing\.app\/Contents\/MacOS\/Google Chrome for Testing$/);
const state=fs.mkdtempSync(path.join(repo,'tests/.state/r-'));
const extension=path.join(state,'extension'),profile=path.join(state,'profile');
const hostName='com.abcastor.gaddi.bridge.test';
const daemon=new FakeDaemon(path.join(state,'b'),undefined);
const call=callsFor(daemon);
let context:BrowserContext|undefined,chrome_:ChildProcess|undefined,chromeExit:Promise<unknown>|undefined;
const server=http.createServer((_req,res)=>{
  res.setHeader('Content-Type','text/html');
  res.end('<title>Render fixture</title><input id="owner"><script>globalThis.renderFrames=0;function tick(){globalThis.renderFrames++;requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>');
});
try {
  fs.cpSync(path.join(repo,'extension'),extension,{recursive:true});
  const bg=path.join(extension,'dist/extension/bg.js');
  fs.writeFileSync(bg,fs.readFileSync(bg,'utf8').replace("const NATIVE_HOST = 'com.abcastor.gaddi.bridge';",`const NATIVE_HOST = '${hostName}';`));
  const native=JSON.parse(fs.readFileSync(path.join(repo,'bridge/com.abcastor.gaddi.bridge.json'),'utf8'));
  native.name=hostName;native.path=path.join(repo,'bridge/host.sh');
  fs.mkdirSync(path.join(profile,'NativeMessagingHosts'),{recursive:true});
  fs.writeFileSync(path.join(profile,'NativeMessagingHosts',`${hostName}.json`),JSON.stringify(native));
  await daemon.start();
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const args=['--headless=new',`--user-data-dir=${profile}`,`--load-extension=${extension}`,`--disable-extensions-except=${extension}`,'--no-first-run','--no-default-browser-check',
    '--disable-background-networking','--disable-component-update','--remote-debugging-port=0','about:blank'];
  requireHeadless(args);
  chrome_=spawn(executablePath,args,{env:{...process.env,GADDI_SOCKET:daemon.socket,GADDI_BRIDGE_LOG:path.join(state,'bridge.log')},stdio:'ignore'});
  let launchError:Error|undefined;chrome_.on('error',error=>{launchError=error;});
  chromeExit=new Promise(resolve=>chrome_!.once('close',resolve));
  const port=await waitFor(()=>{
    if(launchError)throw launchError;
    const file=path.join(profile,'DevToolsActivePort');
    return fs.existsSync(file)&&fs.readFileSync(file,'utf8').split('\n')[0];
  },'test Chrome CDP port');
  context=(await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{noDefaults:true})).contexts()[0];
  const worker=await waitFor(()=>context!.serviceWorkers().find(w=>w.url().endsWith('/dist/extension/bg.js')),'extension worker');
  await waitFor(()=>daemon.attachments.length,'test bridge');
  const owner=context.pages()[0];await owner.goto(url);await owner.bringToFront();
  const ownerTab=await call('chrome.active');
  const agent=await call('chrome.open',{url,group:'● Rendering',browser:{window:'own',show:'attention'}});
  assert.notEqual(agent.windowId,ownerTab.windowId,'ASSERT_RENDER_OWN_WINDOW');
  // Gaddi's placeholder stays the active tab of its window, so the agent tab is behind it.
  // A tab added there by anyone else is moved to the owner's window, so none is created here.
  assert.equal(agent.active,false,'ASSERT_RENDER_BEHIND_ACTIVE_TAB');
  const sample=()=>worker.evaluate(async tab=>(await chrome.scripting.executeScript({target:{tabId:tab},world:'MAIN',func:()=>({visibility:document.visibilityState,focus:document.hasFocus(),frames:(globalThis as unknown as {renderFrames:number}).renderFrames})}))[0].result!,agent.id);
  const windows=()=>worker.evaluate(async()=> (await chrome.windows.getAll()).map(w=>({id:w.id,focused:w.focused,state:w.state})));
  const measure=async()=>{const before=await sample();await new Promise(r=>setTimeout(r,1500));const after=await sample();return {visibility:after.visibility,focus:after.focus,frames:after.frames-before.frames};};
  const baseline=await measure();
  assert.deepEqual(baseline,{visibility:'hidden',focus:false,frames:0},'ASSERT_RENDER_NATIVE_HIDDEN');
  const windowsBefore=await windows();assert.equal(windowsBefore.find(w=>w.id===agent.windowId)!.focused,false);
  // Candidate capture measurements do not export frame data. Every frame is acknowledged.
  const screencast=await worker.evaluate(async tab=>{
    await chrome.debugger.attach({tabId:tab},'1.3');
    let acknowledgements=0;
    const ack=(source:chrome.debugger.Debuggee,method:string,data:object|undefined)=>{
      if(source.tabId!==tab||method!=='Page.screencastFrame')return;
      acknowledgements++;void chrome.debugger.sendCommand(source,'Page.screencastFrameAck',{sessionId:(data as {sessionId:number}).sessionId}).catch(()=>{});
    };
    chrome.debugger.onEvent.addListener(ack);
    try {
      // Read through the attached session: after a screencast on a hidden tab, injected scripts stall.
      const read=async()=>((await chrome.debugger.sendCommand({tabId:tab},'Runtime.evaluate',{expression:'({visibility:document.visibilityState,focus:document.hasFocus(),frames:globalThis.renderFrames})',returnByValue:true})) as {result:{value:{visibility:string;focus:boolean;frames:number}}}).result.value;
      const before=await read();
      await chrome.debugger.sendCommand({tabId:tab},'Page.startScreencast',{format:'jpeg',quality:1,maxWidth:1,maxHeight:1,everyNthFrame:60});
      await new Promise(r=>setTimeout(r,1500));const during=await read();
      await chrome.debugger.sendCommand({tabId:tab},'Page.stopScreencast');
      await new Promise(r=>setTimeout(r,100));const stopped=await read();
      return {visibility:during.visibility,focus:during.focus,frames:during.frames-before.frames,after:stopped.visibility,acknowledgements};
    } finally {chrome.debugger.onEvent.removeListener(ack);await chrome.debugger.detach({tabId:tab});}
  },agent.id);
  const during=(await call('chrome.eval',{tab:agent.id,expression:'new Promise(resolve => { const start=globalThis.renderFrames; setTimeout(() => resolve({visibility:document.visibilityState,focus:document.hasFocus(),frames:globalThis.renderFrames-start}),1500); })'})).value as {visibility:string;focus:boolean;frames:number};
  assert.equal(during.visibility,'visible','ASSERT_RENDER_VISIBLE');assert.ok(during.frames>0,'ASSERT_RENDER_FRAMES');
  await new Promise(r=>setTimeout(r,100));const after=await measure();
  assert.deepEqual(after,{visibility:'hidden',focus:false,frames:0},'ASSERT_RENDER_STOP');
  assert.deepEqual(await windows(),windowsBefore,'ASSERT_RENDER_WINDOW_FOCUS');
  assert.equal((await call('chrome.active')).id,ownerTab.id,'ASSERT_RENDER_OWNER_TAB');
  console.log(`RENDER_MEASUREMENTS ${JSON.stringify({browser:execFileSync(executablePath,['--version'],{encoding:'utf8'}).trim(),baseline,screencast,during,after})}`);
  await call('chrome.close',{tabs:[agent.id]});
  // The placeholder keeps the Gaddi window for the Chrome run (extension/README.md); only the agent tab goes.
  const left=await worker.evaluate(async windowId=>(await chrome.tabs.query({windowId})).map(t=>t.url),agent.windowId);
  assert.deepEqual(left,[await worker.evaluate(()=>chrome.runtime.getURL('placeholder.html'))],'ASSERT_RENDER_WINDOW_PLACEHOLDER_ONLY');
  console.log('== background rendering: 9 passed, 0 failed');
} finally {
  if(chrome_&&chrome_.exitCode===null){
    chrome_.kill('SIGTERM');const killTimer=setTimeout(()=>chrome_!.kill('SIGKILL'),5000);
    await chromeExit;clearTimeout(killTimer);
  }
  await daemon.stop();server.closeAllConnections();
  if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
  fs.rmSync(state,{recursive:true,force:true});
}
