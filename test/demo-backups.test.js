'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const seed=require('../demo/seed.json');
const {DemoCore}=require('../demo/demo-core');
const {validateBackup}=require('../demo/demo-backups');
const backup=()=>({format:'comptoir-demo-backup',version:1,exportedAt:new Date().toISOString(),state:new DemoCore(seed).exportState(),profiles:seed._demoUsers.map(u=>({...u,active:true,demo:true}))});
test('portable backup preserves all data, photos and simulated profiles, including cancellation history',()=>{
  const input=backup(),core=new DemoCore(input.state),user=input.profiles[0];
  core.command(user,{id:randomUUID(),type:'document.create',payload:{type:'sale',storeId:'store-centre',contactId:'customer-awa',lines:[{productId:'product-riz',quantity:1}],paid:0}});
  const doc=core.exportState().documents.at(-1);
  core.command(user,{id:randomUUID(),type:'document.cancel',payload:{documentId:doc.id,reason:'Erreur de saisie'}});
  input.state=core.exportState();const result=validateBackup(input);
  assert.deepEqual(result,input);assert.notEqual(result,input);assert.deepEqual(new DemoCore(result.state).exportState(),core.exportState());
});
test('corrupt quantities, foreign references, hostile photos, unsafe IDs and stored credentials are rejected',()=>{
  for(const change of[
    b=>b.state.stocks[0].quantity=-1,b=>b.state.stocks[0].productId='missing',b=>b.state.products[0].photo='javascript:alert(1)',
    b=>b.profiles[0].password='Secret',b=>b.profiles[0].active=false,b=>b.state.stores[0].id='unsafe\"onclick=alert(1)',
    b=>b.state.documents[0].paid=b.state.documents[0].total+1,b=>b.state.documents[0].payments=[],b=>b.state.products[1].sku=b.state.products[0].sku
  ]){const b=backup();change(b);assert.throws(()=>validateBackup(b),e=>e.code==='INVALID_BACKUP');}
});
