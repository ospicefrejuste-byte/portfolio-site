"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {createApplication}=require('../lib/application');
test('Accès superviseur et paiement public limité au dossier nouvellement inscrit',async t=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'crs-public-'));let verified={status:'FAILED'};
 const instance=createApplication({dataDir,setupToken:'installation-test-only',paymentConfig:{publicKey:'public-test-only',privateKey:'private-test-only',secretKey:'secret-test-only',sandbox:true},verifyTransaction:async()=>verified});
 const server=instance.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(async()=>{await new Promise(r=>server.close(r));instance.db.close();fs.rmSync(dataDir,{recursive:true,force:true})});
 const base='http://127.0.0.1:'+server.address().port;
 async function call(route,body,token,cookie){const r=await fetch(base+route,{method:body?'POST':'GET',redirect:'manual',headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:r.headers.get('content-type')?.includes('json')?await r.json():await r.text(),cookie:r.headers.get('set-cookie')?.split(';')[0],location:r.headers.get('location')}}
 assert.equal((await call('/administration')).location,'/connexion.html');assert.equal((await call('/gestion.html')).status,302);
 const setup=await call('/api/auth/setup',{username:'superviseur',password:'Mot-de-passe-test-123!',token:'installation-test-only'});assert.equal(setup.status,200);assert.equal((await call('/administration',undefined,undefined,setup.cookie)).status,200);
 const body={name:'Élève public fictif',guardian:'Parent fictif',phone:'0000000000',class:'6e',centre:'CSP Les Adorables de la Cité',subjects:['Mathématiques'],consent:true};
 const first=await call('/api/registrations',body),second=await call('/api/registrations',{...body,name:'Autre élève fictif'});assert.equal(first.status,201);assert.equal(first.data.monthlyFee,3500);assert.match(first.data.paymentToken,/^[a-f0-9]{64}$/);
 assert.equal((await call('/api/data',undefined,first.data.paymentToken)).status,401);assert.equal((await call('/administration',undefined,first.data.paymentToken)).status,302);assert.equal((await call('/api/admin/users',undefined,first.data.paymentToken)).status,401);
 assert.equal((await call('/api/registration-payments/config')).status,401);assert.equal((await call('/api/registration-payments/config',undefined,first.data.paymentToken)).status,200);
 assert.equal((await call('/api/registration-payments/checkout',{period:'2026-10',student:'another-student'},first.data.paymentToken)).status,403);
 const order=await call('/api/registration-payments/checkout',{period:'2026-10',amount:1},first.data.paymentToken);assert.equal(order.status,201);assert.equal(order.data.amount,3500);
 const confirmation={orderId:order.data.orderId,transactionId:'test-public-transaction'};
 assert.equal((await call('/api/registration-payments/confirm',confirmation,second.data.paymentToken)).status,403);
 assert.equal((await call('/api/registration-payments/confirm',confirmation,first.data.paymentToken)).status,409);
 verified={status:'SUCCESS',amount:1,data:order.data.data};assert.equal((await call('/api/registration-payments/confirm',confirmation,first.data.paymentToken)).status,409);
 verified={status:'SUCCESS',amount:3500,data:order.data.data};assert.equal((await call('/api/registration-payments/confirm',confirmation,first.data.paymentToken)).status,200);assert.equal((await call('/api/registration-payments/confirm',confirmation,first.data.paymentToken)).data.alreadyConfirmed,true);
 assert.equal(instance.db.prepare("SELECT count(*) n FROM records WHERE kind='payments'").get().n,1);
 instance.db.prepare('UPDATE registration_access SET expires=0').run();assert.equal((await call('/api/registration-payments/config',undefined,first.data.paymentToken)).status,401);
});
