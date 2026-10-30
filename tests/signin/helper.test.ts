import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogin, listLogins, runSignin } from '../../daemon/signin.ts';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gaddi-helper-test-'));
const env = {...process.env};
try {
  process.env.PATH = `${home}:${process.env.PATH}`;
  const write = (body: string) => fs.writeFileSync(path.join(home,'op'),`#!${process.execPath}\n${body}`,{mode:0o700});
  write(`setTimeout(()=>console.log('[]'),8000);`);
  const start = Date.now();
  await assert.rejects(listLogins());
  assert.ok(Date.now()-start < 6500,'ASSERT_LOCK_BOUND: locked/unresponsive op must return within 6.5s');
  console.log('PASS locked/unresponsive 1Password returns before 6.5s, not the previous 60s');
  write(`const fs=require('node:fs'); const args=process.argv.slice(2); const input=JSON.parse(fs.readFileSync(0,'utf8'));
    if(args[0]!=='item'||args[1]!=='create'||args[2]!=='-'||args[args.indexOf('--vault')+1]!=='aaaaaaaaaaaaaaaaaaaaaaaaaa'||!args.includes('--generate-password=letters,digits,symbols,32')||input.fields.some(f=>f.purpose==='PASSWORD')) process.exit(1);
    console.log(JSON.stringify({id:'new-item',title:input.title,vault:{id:'aaaaaaaaaaaaaaaaaaaaaaaaaa'}}));`);
  const item = await createLogin('https://example.test',{title:'Fixture new account',username:'test@example.test',vault:'aaaaaaaaaaaaaaaaaaaaaaaaaa'});
  assert.deepEqual(item,{id:'new-item',title:'Fixture new account',urls:['https://example.test']});
  await assert.rejects(createLogin('https://example.test',{title:'',username:'x',vault:'aaaaaaaaaaaaaaaaaaaaaaaaaa'}));
  console.log('PASS new item uses explicit vault ID, op password generation and stdin, no secret in argv');
  write(`console.log(JSON.stringify([{label:'username',value:'fixture-user'},{label:'password',value:'fixture-password'}]));`);
  const types: string[] = [], remembered: string[] = [];
  const result = await runSignin({site:'https://example.test',item,signup:true,remember:s=>{remembered.push(s);},request:async(name,args)=>{
    assert.equal(args.signin?.signup,true);
    if(name==='signinProbe') return {url:'https://example.test/signup',signature:'form',username:'@u',password:'@p',confirmation:'@c'};
    assert.equal(name,'signinType','signup must never submit via privileged signin path');
    const kind=args.signin?.kind!; types.push(kind);
    assert.equal(args.text,kind==='username'?'fixture-user':'fixture-password');
    return {typed:true};
  }});
  assert.equal(result.outcome,'filled'); assert.deepEqual(types,['username','password','confirmation']);
  assert.equal(remembered.length,2); assert.ok(!JSON.stringify(result).includes('fixture-password'));
  console.log('PASS signup fills username/password/confirmation without exposing or submitting credentials');
} finally { process.env=env; fs.rmSync(home,{recursive:true,force:true}); }
console.log('== helper signin: 3 passed, 0 failed');
