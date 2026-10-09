"use strict";
const {test,after}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const {createApplication,cleanup}=require('./cloud-test-support');
const serverless=require('serverless-http');
test('PostgreSQL : création unique, paiements concurrents, RLS et cookies serverless',async t=>{
 let verified;const instance=await createApplication({dataDir:'parallel-'+crypto.randomUUID(),production:true,publicOrigin:'https://school.test',setupToken:'private-test-only',paymentConfig:{publicKey:'test-public',privateKey:'test-private',secretKey:'test-secret',sandbox:true},verifyTransaction:async()=>verified});
 t.after(()=>instance.db.close());
 const handler=serverless(instance.app);
 async function call(path,body,headers={}){return handler({path,httpMethod:body?'POST':'GET',headers:{host:'school.test',origin:'https://school.test',...(body?{'content-type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):'',requestContext:{identity:{sourceIp:'127.0.0.1'}}},{})}
 const credentials={username:'superviseur',password:'Mot-de-passe-test-123!',token:'private-test-only'};
 const setup=await Promise.all([call('/api/auth/setup',credentials),call('/api/auth/setup',credentials)]);assert.deepEqual(setup.map(r=>r.statusCode).sort(),[200,409],setup.map(r=>r.body).join(' / '));
 const response=setup.find(r=>r.statusCode===200);const cookie=response.multiValueHeaders?.['set-cookie']?.[0]||response.headers?.['set-cookie'];assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/SameSite=Lax/);
 assert.equal((await call('/administration')).statusCode,302);assert.equal((await call('/administration',undefined,{cookie:cookie.split(';')[0]})).statusCode,200);
 const rows=await instance.db.prepare("SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind='r'").all();assert.equal(rows.length,7);assert.ok(rows.every(r=>r.relrowsecurity));
 const registration=await call('/api/registrations',{name:'Élève fictif',guardian:'Parent fictif',phone:'0100000000',class:'6e',centre:'CSP Les Adorables de la Cité',subjects:['Mathématiques'],consent:true});assert.equal(registration.statusCode,201);const access=JSON.parse(registration.body).paymentToken;
 const headers={authorization:'Bearer '+access};const orders=await Promise.all([call('/api/registration-payments/checkout',{period:'2026-10'},headers),call('/api/registration-payments/checkout',{period:'2026-10'},headers)]);assert.ok(orders.every(r=>r.statusCode===201));const order=JSON.parse(orders[0].body);assert.equal(order.orderId,JSON.parse(orders[1].body).orderId);
 verified={status:'SUCCESS',amount:3500,data:order.data};const confirmations=await Promise.all([call('/api/registration-payments/confirm',{orderId:order.orderId,transactionId:'cloud-parallel-payment'},headers),call('/api/registration-payments/confirm',{orderId:order.orderId,transactionId:'cloud-parallel-payment'},headers)]);assert.ok(confirmations.every(r=>r.statusCode===200));assert.equal((await instance.db.prepare("SELECT count(*) n FROM records WHERE kind='payments'").get()).n,1);
 assert.equal((await call('/api/data',undefined,headers)).statusCode,401);
 const limited=await Promise.all(Array.from({length:22},()=>call('/api/auth/login',{username:'inconnu',password:'invalide'})));assert.ok(limited.some(r=>r.statusCode===429));
 const limits=await instance.db.prepare('SELECT count FROM request_limits').all();assert.ok(limits.some(r=>r.count>=22));
});
after(cleanup);
