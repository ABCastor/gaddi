import assert from 'node:assert/strict';
import { pageTask } from '../../extension/content.ts';
// Reuse the real isolated-world DOM fixture with explicit signup authority.
import './extension.test.ts';
const site = 'https://example.test';
// Minimal DOM for a new-account form, not a real account or vault.
class Field {
  tagName = 'INPUT'; type: string; value = ''; disabled = false; readOnly = false; isConnected = true;
  form: unknown; childNodes: unknown[] = [];
  attributes: Record<string,string>;
  constructor(attributes: Record<string,string>) { this.attributes = attributes; this.type = attributes.type || 'text'; }
  getAttribute(k: string) { return this.attributes[k] ?? null; }
  hasAttribute(k: string) { return k in this.attributes; }
  matches(k: string) { return k === ':disabled' && this.disabled; }
  closest() { return null; }
  getClientRects() { return [{}]; }
}
const fields = [new Field({type:'email',autocomplete:'email'}), new Field({type:'password',autocomplete:'new-password'}), new Field({type:'password',autocomplete:'new-password',name:'confirm-password'})];
const form = { tagName:'FORM', isConnected:true, getAttribute:()=>'/register', elements:fields };
fields.forEach(f => f.form = form);
Object.assign(globalThis, {document:{title:'Join',body:{innerText:'Create account'},baseURI:site+'/register',querySelectorAll:(s:string)=>s==='*'?fields:[]},location:{href:site+'/register'}});
delete globalThis.__gaddiElements;
const ordinary = await pageTask('signinProbe',{signin:{site}});
assert.equal(ordinary.challenge,true, 'ordinary signin must not silently register');
const signup = await pageTask('signinProbe',{signin:{site,signup:true}});
assert.equal(signup.challenge,undefined, 'ASSERT_SIGNUP_FIELDS');
assert.ok(signup.password && signup.confirmation && signup.username);
assert.ok(!JSON.stringify(signup).includes('new-password'), 'return refs, not values');
console.log('PASS explicit signup discovers email, new password and confirmation; ordinary signin still refuses');
