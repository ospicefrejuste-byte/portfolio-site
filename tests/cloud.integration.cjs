"use strict";
const fs=require('node:fs');const path=require('node:path');const Module=require('node:module');
const {after}=require('node:test');const {cleanup}=require('./cloud-test-support');
const parser=require('@babel/parser');const traverse=require('@babel/traverse').default;const generate=require('@babel/generator').default;const t=require('@babel/types');
if(!process.env.CRS_TEST_DATABASE_URL)throw Error('Configurez CRS_TEST_DATABASE_URL avec une base PostgreSQL de test.');
// Run the same behavioral scenarios against a real PostgreSQL database.
for(const name of ['application.test.js','payments.test.js','public-registration.test.js']){
 let source=fs.readFileSync(path.join(__dirname,name),'utf8').replace('require("../lib/application")','require("./cloud-test-support")').replace("require('../lib/application')","require('./cloud-test-support')");
 if(name==='payments.test.js')source=source.slice(0,source.indexOf('test("Paiement désactivé'));
 const ast=parser.parse(source);
 traverse(ast,{CallExpression:{exit(p){const n=p.node;if(p.parentPath.isAwaitExpression())return;let wanted=t.isIdentifier(n.callee,{name:'createApplication'});if(t.isMemberExpression(n.callee)){const property=n.callee.property.name,object=n.callee.object;wanted||=['get','run','all'].includes(property)&&t.isCallExpression(object)&&t.isMemberExpression(object.callee)&&object.callee.property.name==='prepare';wanted||=property==='close'&&t.isMemberExpression(object)&&object.property.name==='db';}if(wanted){const func=p.getFunctionParent();if(!func)throw Error('Invalid async test');func.node.async=true;p.replaceWith(t.awaitExpression(n));p.skip()}}}});
 const filename=path.join(__dirname,name);const mod=new Module(filename,module);mod.filename=filename;mod.paths=Module._nodeModulePaths(__dirname);mod._compile(generate(ast).code,filename);
}
after(cleanup);
