"use strict";
// Generate asynchronous PostgreSQL handlers from the tested SQLite application.
// This keeps the authorization and validation rules in a single source of truth.
const fs=require('node:fs');const path=require('node:path');
const parser=require('@babel/parser');const traverse=require('@babel/traverse').default;const generate=require('@babel/generator').default;const t=require('@babel/types');
const root=path.join(__dirname,'..');
const asyncNames=new Set(['createApplication','createPaymentService','initialized','snapshot','insert','transaction','session','auth','registrationAuth']);
function transform(source){const ast=parser.parse(source);traverse(ast,{CallExpression:{exit(p){const n=p.node;if(p.parentPath.isAwaitExpression())return;let wanted=t.isIdentifier(n.callee)&&asyncNames.has(n.callee.name);if(t.isMemberExpression(n.callee)){const name=n.callee.property.name,object=n.callee.object;wanted||=t.isIdentifier(object,{name:'payments'})&&['orders','checkout'].includes(name);wanted||=t.isIdentifier(object,{name:'db'})&&name==='exec';wanted||=['all','get','run'].includes(name)&&t.isCallExpression(object)&&t.isMemberExpression(object.callee)&&object.callee.property.name==='prepare';}if(wanted){const func=p.getFunctionParent();if(!func)throw Error('Await outside function');func.node.async=true;p.replaceWith(t.awaitExpression(n));p.skip()}}}});return generate(ast,{comments:true}).code+'\n'}
let application=fs.readFileSync(path.join(root,'lib/application.js'),'utf8');
application=application.replace('const { DatabaseSync } = require("node:sqlite");','const { createPostgres } = require("./postgres");').replace('const { createPaymentService } = require("./payments");','const { createPaymentService } = require("./cloud-payments");').replace('function createApplication(options = {}) {','async function createApplication(options = {}) {');
const start=application.indexOf('  fs.mkdirSync(dataDir');const end=application.indexOf('  const initialized =',start);
let schema=application.slice(application.indexOf('db.exec(`',start)+9,application.indexOf('`);',start));
schema=schema.replace(/PRAGMA[^;]+;\s*/g,'').replace('username TEXT UNIQUE COLLATE NOCASE NOT NULL','username TEXT NOT NULL').replace(/expires INTEGER/g,'expires BIGINT');
schema+='\nCREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users(lower(username));\nCREATE TABLE IF NOT EXISTS request_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires BIGINT NOT NULL);';
application=application.slice(0,start)+'  const db = options.database || createPostgres();\n  try {\n  await db.transaction(async () => { await db.exec('+JSON.stringify(schema)+'); });\n  const publicDir = options.publicDir || path.join(__dirname, "..", "public");\n'+application.slice(end);
const tokenStart=application.indexOf('  const tokenFile =');const tokenEnd=application.indexOf('  const dummyHash',tokenStart);
application=application.slice(0,tokenStart)+'  const tokenFile = "";\n  let setupToken = options.setupToken || process.env.CRS_SETUP_TOKEN;\n  if (!setupToken && !(await initialized())) throw Error("Configurez le code privé CRS_SETUP_TOKEN avant la première installation.");\n'+application.slice(tokenEnd);
const limitStart=application.indexOf('  const attempts =');const limitEnd=application.indexOf('  const snapshot =',limitStart);
application=application.slice(0,limitStart)+`  function limit(scope,count){return async (req,res,next)=>{const now=Date.now();const key=sha(scope+":"+req.ip);const entry=await db.prepare("INSERT INTO request_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN request_limits.expires<? THEN 1 ELSE request_limits.count+1 END,expires=CASE WHEN request_limits.expires<? THEN excluded.expires ELSE request_limits.expires END RETURNING count,expires").get(key,now+15*60*1000,now,now);if(entry.count>count){res.set("Retry-After",String(Math.ceil((entry.expires-now)/1000)));return next(fail(429,"Trop de tentatives. Réessayez dans quelques minutes."));}next();};}\n`+application.slice(limitEnd);
const snapStart=application.indexOf('  const snapshot =');const snapEnd=application.indexOf('  function insert',snapStart);
application=application.slice(0,snapStart)+`  const snapshot = async () => {const data=Object.fromEntries(kinds.map(k=>[k,[]]));for(const row of await db.prepare("SELECT kind,payload FROM records").all())if(data[row.kind])data[row.kind].push(JSON.parse(row.payload));return data;};\n`+application.slice(snapEnd);
const transStart=application.indexOf('  function transaction(');const transEnd=application.indexOf('  function session',transStart);
application=application.slice(0,transStart)+'  const transaction = fn => db.transaction(fn);\n'+application.slice(transEnd);
application=application.replaceAll('WHERE username=?','WHERE lower(username)=lower(?)').replaceAll('path.join(__dirname, "..", "public"','path.resolve(publicDir');
application=application.replace('  app.use(express.json({ limit: "32kb" }));', `  app.use((req,res,next)=>{if(req.apiGateway && Buffer.isBuffer(req.body)){if(req.body.length>32768)return next(fail(413,"Données trop volumineuses."));if(req.body.length){if(!(req.get("Content-Type")||"").toLowerCase().startsWith("application/json"))return next(fail(415,"Envoyez un objet JSON."));try{req.body=JSON.parse(req.body.toString("utf8"));}catch{return next(fail(400,"JSON invalide."));}}else req.body=undefined;}next();});\n  app.use(express.json({ limit: "32kb" }));`);
// An asynchronous Express callback is required for protected HTML pages too.

application=application.replace('  app.use("/api", (req, res, next) => next(fail(404, "Route inconnue.")));','  await db.transaction(async () => { for (const name of ["settings","records","users","sessions","registration_access","payment_orders","request_limits"]) await db.exec("ALTER TABLE " + name + " ENABLE ROW LEVEL SECURITY"); });\n  app.use("/api", (req, res, next) => next(fail(404, "Route inconnue.")));');
// The publicDir declaration must retain its original fallback after replacement.
application=application.replace('const publicDir = options.publicDir || path.resolve(publicDir);','const publicDir = options.publicDir || path.join(__dirname, "..", "public");');
application=application.replace('return { app, db, dataDir, initialized };\n}', 'return { app, db, dataDir, initialized };\n  } catch (error) { await db.close(); throw error; }\n}');
fs.writeFileSync(path.join(root,'lib/cloud-application.js'),transform(application));
let payments=fs.readFileSync(path.join(root,'lib/payments.js'),'utf8');payments=payments.replace('  db.exec(`','  await db.transaction(async () => { await db.exec(`').replace("WHERE state='paid';`);","WHERE state='paid';`); });");
payments=payments.replace('function createPaymentService({','async function createPaymentService({');
fs.writeFileSync(path.join(root,'lib/cloud-payments.js'),transform(payments));
console.log('Serveur PostgreSQL généré. Aucun secret inclus.');
