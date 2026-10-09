/* Portable backups contain fictitious local data and simulated profiles only. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;else root.ComptoirDemoBackups=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const fail=()=>{throw Object.assign(new Error('Sauvegarde invalide ou incompatible. Les données actuelles ont été conservées.'),{code:'INVALID_BACKUP',status:400});};
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
  const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(value);
  const money=value=>Number.isSafeInteger(value)&&value>=0&&value<=1e12;
  const qty=(value,signed=false)=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e9&&(signed||value>=0)&&Math.abs(Math.round(value*1000)/1000-value)<1e-8;
  const text=(value,max)=>typeof value==='string'&&value.length<=max;
  function validateBackup(input){
    let encoded,backup;
    try{encoded=JSON.stringify(input);if(new TextEncoder().encode(encoded).length>25*1024*1024)fail();backup=JSON.parse(encoded);}catch{fail();}
    if(!object(backup)||backup.format!=='comptoir-demo-backup'||backup.version!==1||!Number.isFinite(Date.parse(backup.exportedAt))||!object(backup.state)||!Array.isArray(backup.profiles))fail();
    const state=backup.state, maps={};
    for(const table of['products','stores','documents','contacts','inventories','expenses']){
      if(!Array.isArray(state[table])||state[table].length>50000)fail();
      maps[table]=new Map();
      for(const row of state[table]){if(!object(row)||!id(row.id)||maps[table].has(row.id))fail();maps[table].set(row.id,row);}
    }
    const ref=(table,value)=>maps[table].has(value),safeDate=value=>text(value,40)&&Number.isFinite(Date.parse(value));
    if(!state.stores.length||state.stores.some(s=>!text(s.name,160)||!s.name.trim()||!text(s.city||'',160)||(s.version!=null&&(!Number.isSafeInteger(s.version)||s.version<1))))fail();
    state.stores.forEach(s=>{s.version ||= 1;});
    const skus=new Set();
    for(const p of state.products){
      if(!text(p.name,160)||!p.name.trim()||!text(p.sku,100)||!p.sku.trim()||skus.has(p.sku.toLowerCase())||!text(p.unit,30)||!text(p.category,160)||!text(p.brand,100)||!text(p.location,160)||!text(p.notes,3000)||!money(p.purchasePrice)||!money(p.sellingPrice)||!qty(p.minStock)||!Number.isSafeInteger(p.version)||p.version<1||!/^#[a-f0-9]{6}$/i.test(p.color)||!Array.isArray(p.tags)||p.tags.length>30||p.tags.some(t=>!text(t,60))||!text(p.photo,7000000))fail();
      skus.add(p.sku.toLowerCase());
      if(p.photo){if(!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(p.photo))fail();try{atob(p.photo.slice(p.photo.indexOf(',')+1));}catch{fail();}}
    }
    if(!Array.isArray(state.stocks))fail();const stocks=new Set();
    for(const s of state.stocks){const key=JSON.stringify([s.productId,s.storeId]);if(!object(s)||!ref('products',s.productId)||!ref('stores',s.storeId)||!qty(s.quantity)||!Number.isSafeInteger(s.version)||s.version<0||stocks.has(key))fail();stocks.add(key);}
    if(stocks.size!==state.products.length*state.stores.length)fail();
    for(const c of state.contacts)if(!['customer','supplier'].includes(c.type)||!text(c.name,160)||!c.name.trim()||!text(c.phone,50)||!text(c.address,500)||!text(c.taxId,100))fail();
    for(const d of state.documents){
      if(!['sale','purchase','transfer','adjustment'].includes(d.type)||!ref('stores',d.storeId)||(d.type==='transfer'&&(!ref('stores',d.toStoreId)||d.toStoreId===d.storeId))||(d.contactId&&!ref('contacts',d.contactId))||!money(d.total)||!money(d.paid)||d.paid>d.total||!safeDate(d.date)||!safeDate(d.createdAt)||!id(d.createdBy)||!text(d.number,100)||!text(d.note,4000)||!Array.isArray(d.lines)||!d.lines.length||d.lines.length>500||!Array.isArray(d.payments))fail();
      const lines=new Set();let total=0;
      for(const l of d.lines){if(!ref('products',l.productId)||lines.has(l.productId)||!qty(l.quantity,d.type==='adjustment')||!l.quantity||!money(l.unitPrice)||!money(l.purchaseCost)||!text(l.name,160)||!text(l.sku,100)||!text(l.unit,30))fail();lines.add(l.productId);total+=Math.round(l.quantity*l.unitPrice);}
      if(!d.reversalOf&&total!==d.total)fail();
      if(d.reversalOf&&(!ref('documents',d.reversalOf)||d.total||d.paid))fail();
      if(d.status!=null&&d.status!=='cancelled')fail();
      if(d.status==='cancelled'&&(!ref('documents',d.reversalDocumentId)||d.paid||!text(d.cancellationReason,1000)))fail();
      let paid=0;const payments=new Set();
      for(const p of d.payments){if(!id(p.id)||payments.has(p.id)||!money(p.amount)||!p.amount||!safeDate(p.date)||!safeDate(p.createdAt)||!id(p.createdBy))fail();payments.add(p.id);paid+=p.amount;}
      if(paid!==d.paid)fail();
    }
    for(const inv of state.inventories){
      if(!ref('stores',inv.storeId)||!['draft','validated'].includes(inv.status)||!text(inv.name,160)||!text(inv.category,160)||!safeDate(inv.createdAt)||!Array.isArray(inv.lines)||!inv.lines.length)fail();
      const ids=new Set();for(const l of inv.lines){if(!ref('products',l.productId)||ids.has(l.productId)||!qty(l.theoretical)||(l.counted!==null&&!qty(l.counted))||!Number.isSafeInteger(l.stockVersion)||l.stockVersion<0)fail();ids.add(l.productId);}
      if(inv.documentId&&!ref('documents',inv.documentId))fail();
      if(inv.status==='validated'&&(inv.lines.some(l=>l.counted===null)||!safeDate(inv.validatedAt)))fail();
    }
    for(const e of state.expenses)if(!ref('stores',e.storeId)||!money(e.amount)||!safeDate(e.date)||!text(e.category,100)||!text(e.note,2000)||!safeDate(e.createdAt))fail();
    if(!object(state.settings)||state.settings.currency!=='XOF'||typeof state.settings.noPrices!=='boolean'||!text(state.settings.businessName,160))fail();
    state._commands ||= [];const commands=new Set();
    if(!Array.isArray(state._commands))fail();for(const c of state._commands){if(!id(c.id)||commands.has(c.id)||!id(c.userId)||!text(c.signature,20000000)||!safeDate(c.createdAt))fail();commands.add(c.id);}
    const profiles=new Set(),emails=new Set();
    for(const p of backup.profiles){if(!object(p)||Object.keys(p).some(k=>!['id','email','name','role','active','demo'].includes(k))||!id(p.id)||profiles.has(p.id)||!text(p.email,254)||!/^\S+@\S+\.\S+$/.test(p.email)||emails.has(p.email.toLowerCase())||!text(p.name,160)||!p.name.trim()||!['admin','cashier','inventory'].includes(p.role)||typeof p.active!=='boolean'||p.demo!==true)fail();profiles.add(p.id);emails.add(p.email.toLowerCase());}
    if(!backup.profiles.some(p=>p.role==='admin'&&p.active))fail();
    return backup;
  }
  return {validateBackup};
});
