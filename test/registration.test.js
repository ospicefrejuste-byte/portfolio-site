'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtempSync,rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { StockService } = require('../lib/business');
const { createMailer } = require('../lib/mailer');
const { createApp } = require('../server');
const password='UnePhraseSecrete2026!';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1sAAAAASUVORK5CYII=','base64');

async function fixture(t,production=false) {
  const directory=mkdtempSync(path.join(tmpdir(),'comptoir-signup-'));
  const mailer=createMailer({env:{NODE_ENV:'test',EMAIL_TRANSPORT:'capture'}});
  const service=new StockService({dbPath:path.join(directory,'stock.sqlite'),production,registrationEnabled:true,mailer});
  const app=createApp({service,uploadDir:path.join(directory,'uploads')});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});service.close();rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(route,body,cookie,headers={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...headers},body:JSON.stringify(body)});
  const get=(route,cookie)=>fetch(base+route,{headers:cookie?{Cookie:cookie}:{}});
  async function signup(email,shopName='Ma boutique') {
    const response=await post('/api/register',{email,name:'Awa Adom',password,shop:{name:shopName,city:'Cotonou',address:'Akpakpa',phone:'+229 01 97 00 00 00',taxId:'IFU-EXEMPLE'}});
    assert.equal(response.status,202);
    const pending=await response.json();
    const code=mailer.getCapturedMessages({includeCode:true}).at(-1).code;
    const verify=await post('/api/register/verify',{email,registrationId:pending.registrationId,code});
    assert.equal(verify.status,200);
    return {user:(await verify.json()).user,cookie:verify.headers.get('set-cookie').split(';')[0],pending,code};
  }
  return {service,mailer,post,get,signup,base};
}

test('real HTTP signup sends a captured email, commits owner/shop only after verification, then logs in',async t=>{
  const f=await fixture(t,true);
  const email=' awa@example.test ';
  const pendingResponse=await f.post('/api/register',{email,name:'Awa',password,shop:{name:'Épicerie La Grâce',city:'Cotonou'}});
  assert.equal(pendingResponse.status,202);assert.equal(pendingResponse.headers.get('set-cookie'),null);
  const pending=await pendingResponse.json(),code=f.mailer.getCapturedMessages({includeCode:true}).at(-1).code;
  assert.match(code,/^\d{6}$/);assert.ok(!JSON.stringify(pending).includes(code));
  assert.equal(f.service.db.prepare('SELECT id FROM users WHERE email=?').get('awa@example.test'),undefined);
  const saved=f.service.db.prepare('SELECT * FROM registrations WHERE id=?').get(pending.registrationId);
  assert.notEqual(saved.password_hash,password);assert.notEqual(saved.code_hash,code);
  assert.equal((await f.post('/api/login',{email,password})).status,401);
  const bad=await f.post('/api/register/verify',{email,registrationId:pending.registrationId,code:code==='000000'?'111111':'000000'});
  assert.equal(bad.status,400);assert.equal(f.service.db.prepare('SELECT attempts FROM registrations WHERE id=?').get(pending.registrationId).attempts,1);
  const response=await f.post('/api/register/verify',{email,registrationId:pending.registrationId,code});
  assert.equal(response.status,200);
  assert.match(response.headers.get('set-cookie'),/HttpOnly/);assert.match(response.headers.get('set-cookie'),/Secure/);
  const body=await response.json();assert.equal(body.user.role,'admin');assert.equal(body.user.email,'awa@example.test');assert.ok(!('token'in body));
  const cookie=response.headers.get('set-cookie').split(';')[0],state=await(await f.get('/api/state',cookie)).json();
  assert.equal(state.stores.length,1);assert.equal(state.stores[0].name,'Épicerie La Grâce');assert.deepEqual(state.products,[]);assert.equal(state.settings.currency,'XOF');
  assert.equal((await f.post('/api/register/verify',{email,registrationId:pending.registrationId,code})).status,400);
  assert.equal((await f.post('/api/login',{email,password})).status,200);
  assert.equal(f.service.db.prepare('SELECT COUNT(*) n FROM tenants').get().n,1);
});

test('resends rotate the code, preserve attempt limits, expire and prevent reuse',async t=>{
  const f=await fixture(t);
  const email='codes@example.test',body={email,name:'Code',password,shop:{name:'Codes'}};
  const pending=await(await f.post('/api/register',body)).json(),request={email,registrationId:pending.registrationId};
  const oldCode=f.mailer.getCapturedMessages({includeCode:true}).at(-1).code;
  assert.equal((await f.post('/api/register/resend',request)).status,429);
  f.service.db.prepare('UPDATE registrations SET sent_at=0 WHERE id=?').run(pending.registrationId);
  assert.equal((await f.post('/api/register/resend',request)).status,202);
  const newCode=f.mailer.getCapturedMessages({includeCode:true}).at(-1).code;
  if(oldCode!==newCode) assert.equal((await f.post('/api/register/verify',{...request,code:oldCode})).status,400);
  const wrong=newCode==='123456'?'654321':'123456';
  for(let i=0;i<5;i++)assert.equal((await f.post('/api/register/verify',{...request,code:wrong})).status,400);
  assert.equal((await f.post('/api/register/verify',{...request,code:newCode})).status,400);
  f.service.db.prepare('UPDATE registrations SET sent_at=0 WHERE id=?').run(pending.registrationId);
  assert.equal((await f.post('/api/register/resend',request)).status,202);
  const current=f.mailer.getCapturedMessages({includeCode:true}).at(-1).code;
  f.service.db.prepare('UPDATE registrations SET expires=0 WHERE id=?').run(pending.registrationId);
  assert.equal((await f.post('/api/register/verify',{...request,code:current})).status,400);
  assert.equal(f.service.db.prepare('SELECT id FROM users WHERE email=?').get(email),undefined);
});

test('independent owners cannot read or mutate each other’s users, stocks, documents, settings or images',async t=>{
  const f=await fixture(t),a=await f.signup('owner-a@example.test','Commerce A'),b=await f.signup('owner-b@example.test','Commerce B');
  const run=(actor,type,payload)=>f.post('/api/commands',{id:randomUUID(),type,payload},actor.cookie);
  const state=async actor=>(await(await f.get('/api/state',actor.cookie)).json());
  const aStore=(await state(a)).stores[0].id,bStore=(await state(b)).stores[0].id;
  for(const actor of[a,b])assert.equal((await run(actor,'product.save',{name:'Article',sku:'SAME-SKU',unit:'pièce',purchasePrice:50,sellingPrice:100})).status,200);
  const aProduct=(await state(a)).products[0],bProduct=(await state(b)).products[0];
  assert.notEqual(aProduct.id,bProduct.id);
  assert.equal((await run(b,'contact.save',{name:'Client B',type:'customer'})).status,200);
  const bContact=(await state(b)).contacts[0];
  assert.equal((await run(b,'document.create',{type:'purchase',storeId:bStore,lines:[{productId:bProduct.id,quantity:10,unitPrice:50}],paid:500})).status,200);
  assert.equal((await run(b,'inventory.create',{storeId:bStore,name:'Comptage B'})).status,200);
  const before=await state(b),bDocument=before.documents[0],bInventory=before.inventories[0];
  for(const [type,payload]of[
    ['document.create',{type:'transfer',storeId:aStore,toStoreId:bStore,lines:[{productId:aProduct.id,quantity:1}]}],
    ['document.create',{type:'purchase',storeId:aStore,contactId:bContact.id,lines:[{productId:aProduct.id,quantity:1}],paid:0}],
    ['document.create',{type:'adjustment',storeId:aStore,lines:[{productId:bProduct.id,quantity:1}]}],
    ['product.save',{...bProduct,expectedVersion:0}],['store.save',{id:bStore,name:'Intrusion',expectedVersion:0}],
    ['contact.save',{...bContact,name:'Intrusion'}],['payment.create',{documentId:bDocument.id,amount:1}],
    ['document.cancel',{documentId:bDocument.id,reason:'Intrusion'}],
    ['inventory.count',{inventoryId:bInventory.id,counts:[{productId:bProduct.id,quantity:0}]}],
    ['inventory.validate',{inventoryId:bInventory.id}],['expense.create',{storeId:bStore,category:'Vol',amount:1}]
  ]) {const res=await run(a,type,payload);assert.ok([404,409].includes(res.status),`${type}: ${res.status}`);}
  const update=await fetch(f.base+'/api/admin/users/'+b.user.id,{method:'PATCH',headers:{Cookie:a.cookie,'Content-Type':'application/json'},body:JSON.stringify({role:'cashier'})});
  assert.equal(update.status,404);
  const users=await(await f.get('/api/admin/users',a.cookie)).json();assert.ok(users.users.every(u=>u.id!==b.user.id));
  const employee=await f.post('/api/admin/users',{email:'cashier-a@example.test',name:'Caissier A',role:'cashier',password,active:true},a.cookie);
  assert.equal(employee.status,201);
  const employeeId=(await employee.json()).user.id;
  assert.equal(f.service.tenantFor({id:employeeId}),f.service.tenantFor(a.user));
  const cashAuth=await f.post('/api/login',{email:'cashier-a@example.test',password});
  const cashState=await(await f.get('/api/state',cashAuth.headers.get('set-cookie').split(';')[0])).json();
  assert.equal(cashState.stores[0].id,aStore);assert.ok(cashState.products.every(p=>!('purchasePrice'in p)));
  const demote=await fetch(f.base+'/api/admin/users/'+a.user.id,{method:'PATCH',headers:{Cookie:a.cookie,'Content-Type':'application/json'},body:JSON.stringify({role:'cashier'})});
  assert.equal(demote.status,409);
  assert.equal((await run(a,'settings.update',{businessName:'Commerce A changé',noPrices:true})).status,200);
  assert.deepEqual(await state(b),before);
  const form=new FormData();form.append('images',new Blob([png],{type:'image/png'}),'photo.png');
  const upload=await fetch(f.base+'/upload',{method:'POST',headers:{Cookie:b.cookie},body:form});assert.equal(upload.status,200);
  const image=(await upload.json())[0];assert.equal((await f.get(image,b.cookie)).status,200);assert.equal((await f.get(image,a.cookie)).status,404);
  assert.equal((await run(a,'product.save',{...aProduct,photo:image,expectedVersion:aProduct.version})).status,404);
  const legacy=f.service.authenticate('admin@stock.local','Demo2026!').user;
  assert.ok(f.service.state(legacy).stores.every(s=>s.id!==aStore&&s.id!==bStore));
  assert.equal(f.service.scopeTenant,null);
});

test('duplicate addresses get the generic response; missing production email and cross-site requests fail safely',async t=>{
  const f=await fixture(t);await f.signup('existing@example.test');
  const response=await f.post('/api/register',{email:'EXISTING@example.test',name:'Autre',password,shop:{name:'Autre'}});
  assert.equal(response.status,202);const body=await response.json();assert.equal(body.verificationRequired,true);assert.ok(!JSON.stringify(body).includes('already'));
  assert.equal((await f.post('/api/register',{email:'x@example.test'},null,{Origin:'https://attacker.invalid'})).status,403);
  const service=new StockService({dbPath:':memory:',production:true,registrationEnabled:true});t.after(()=>service.close());
  await assert.rejects(service.register({email:'nomail@example.test',name:'No Mail',password,shop:{name:'Boutique'}}),e=>e.code==='EMAIL_NOT_CONFIGURED'&&e.status===503);
  assert.equal(service.db.prepare('SELECT COUNT(*) n FROM registrations').get().n,0);
  assert.equal(service.db.prepare('SELECT COUNT(*) n FROM users').get().n,0);
});

test('failed verification transaction leaves no session or partial shop, and the valid code can be retried',async t=>{
  const f=await fixture(t),email='atomic@example.test';
  const pending=await(await f.post('/api/register',{email,name:'Atomic',password,shop:{name:'Atomic shop'}})).json();
  const code=f.mailer.getCapturedMessages({includeCode:true}).at(-1).code,original=f.service.put;
  f.service.put=function(table,value){if(table==='settings'&&this.scopeTenant)throw new Error('simulated ledger failure');return original.call(this,table,value);};
  const failed=await f.post('/api/register/verify',{email,registrationId:pending.registrationId,code});
  assert.equal(failed.status,500);assert.equal(failed.headers.get('set-cookie'),null);
  assert.equal(f.service.db.prepare('SELECT COUNT(*) n FROM tenants').get().n,0);
  assert.equal(f.service.db.prepare('SELECT id FROM users WHERE email=?').get(email),undefined);
  assert.equal(f.service.scopeTenant,null);
  f.service.put=original;
  assert.equal((await f.post('/api/register/verify',{email,registrationId:pending.registrationId,code})).status,200);
});

test('public registration limits repeated anonymous requests before expensive work',async t=>{
  const f=await fixture(t);
  for(let i=0;i<10;i++)assert.equal((await f.post('/api/register',{email:`invalid-${i}@example.test`})).status,400);
  const blocked=await f.post('/api/register',{email:'last@example.test'});
  assert.equal(blocked.status,429);assert.equal((await blocked.json()).code,'RATE_LIMITED');
  assert.equal(f.mailer.getCapturedMessages().length,0);
});
