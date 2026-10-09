"use strict";
const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const parser=require('@babel/parser');const traverse=require('@babel/traverse').default;const generate=require('@babel/generator').default;const t=require('@babel/types');
if(!process.env.CRS_TEST_DATABASE_URL)throw Error('Utilisez une base PostgreSQL réservée aux tests.');
for(const name of ['browser-smoke.cjs','browser-public.cjs']){
 const root=path.join(__dirname,'..','tests');const target=path.join(root,'.cloud-browser.generated.cjs');
 let source=fs.readFileSync(path.join(root,name),'utf8').replace('require("../lib/application")','require("./cloud-test-support")').replace("require('../lib/application')","require('./cloud-test-support')").replace('})().catch','})().finally(()=>require("./cloud-test-support").cleanup()).catch');
 const ast=parser.parse(source);traverse(ast,{CallExpression:{exit(p){const n=p.node;if(p.parentPath.isAwaitExpression())return;let wanted=t.isIdentifier(n.callee,{name:'createApplication'});if(t.isMemberExpression(n.callee)){const property=n.callee.property.name,object=n.callee.object;wanted||=['get','run','all'].includes(property)&&t.isCallExpression(object)&&t.isMemberExpression(object.callee)&&object.callee.property.name==='prepare';wanted||=property==='close'&&t.isMemberExpression(object)&&object.property.name==='db';}if(wanted){p.getFunctionParent().node.async=true;p.replaceWith(t.awaitExpression(n));p.skip()}}}});
 fs.writeFileSync(target,generate(ast).code);let result;try{result=spawnSync(process.execPath,[target],{stdio:'inherit',env:process.env})}finally{fs.rmSync(target,{force:true})}if(result.status!==0)process.exit(result.status||1);
}
