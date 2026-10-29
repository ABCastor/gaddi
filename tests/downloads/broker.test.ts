import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { exerciseHelperBroker } from '../signin/helper-broker.ts';
import type { ChromeParams } from '../../shared/protocol.ts';
const state=fs.mkdtempSync(path.join(os.tmpdir(),'gaddi-helper-fake-'));
const site='http://127.0.0.1:18987';let phase='form',url=site+'/signup',next=0;
const tabs:{id:number;url:string}[]=[];
const filled=new Map<string,string>();let capture=false;
const transport={async request(method:string,raw:object={}){
  const params=raw as ChromeParams;let result:unknown;
  if(method==='chrome.open'){url=params.url!;const tab={id:++next,url};tabs.push(tab);result=tab;}
  else if(method==='chrome.tabs')result={tabs};
  else if(method==='chrome.active')result=tabs.at(-1);
  else if(method==='chrome.close'){for(const id of params.tabs||[])tabs.splice(tabs.findIndex(t=>t.id===id),1);result={closed:params.tabs,failed:[]};}
  else if(method==='chrome.signinProbe')result={url,signature:phase,username:'@username',password:'@password',confirmation:'@confirmation'};
  else if(method==='chrome.signinType'){filled.set(params.signin!.kind!,params.text!);result={typed:true};}
  else if(method==='chrome.signinSubmit')throw new Error('Signup must not use a privileged submit');
  else if(method==='chrome.describe')result={name:url.includes('download')?'Export ZIP':'Create account',tag:'BUTTON',type:'submit',autocomplete:'',href:'',selector:params.selector,password:false,disabled:false,submitName:'',matched:[]};
  else if(method==='chrome.approvalCapture')result={};
  else if(method==='chrome.click'){
    if(!url.includes('download')){assert.equal(filled.get('username'),'fixture-user');assert.equal(filled.get('password'),'fixture-password');assert.equal(filled.get('confirmation'),'fixture-password');phase='complete';}
    result={clicked:true,tab:params.tab,url,changed:true};
  }
  else if(method==='chrome.read')result={tab:params.tab,url,text:phase==='complete'?'Signed in':'Create account',outline:'',scroll:{y:0,height:100}};
  else if(method==='chrome.downloadArm'){capture=true;result={armed:true};}
  else if(method==='chrome.downloadPoll'){assert.ok(capture);result={ready:true,bytes:24,chunks:1};}
  else if(method==='chrome.downloadChunk')result={data:Buffer.from('fixture generated export').toString('base64')};
  else if(method==='chrome.downloadEnd'){capture=false;result={ended:true};}
  else throw new Error(`Unexpected fixture method ${method}`);
  return {id:0,result};
}};
try {
  await exerciseHelperBroker({site,daemon:transport,state,username:'fixture-user',password:'fixture-password',reset(){phase='form';filled.clear();}});
  console.log('== helper broker contracts passed');
} finally {fs.rmSync(state,{recursive:true,force:true});}
