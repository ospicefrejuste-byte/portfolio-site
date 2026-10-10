"use strict";
const {Pool}=require('pg');
const {AsyncLocalStorage}=require('node:async_hooks');
const {X509Certificate}=require('node:crypto');
function normalizeCaCertificate(value){
 if(!value)return undefined;
 const text=value.replace(/\\r\\n|\\n|\\r/g,'\n');
 const blocks=[...text.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)];
 if(!blocks.length)throw Object.assign(new Error('DATABASE_CA_CERT doit contenir un certificat PEM complet.'),{code:'INVALID_DATABASE_CA_CERT'});
 return blocks.map(([,body])=>{
  const base64=body.replace(/\s/g,'');
  const pem='-----BEGIN CERTIFICATE-----\n'+(base64.match(/.{1,64}/g)||[]).join('\n')+'\n-----END CERTIFICATE-----\n';
  try{new X509Certificate(pem)}catch{throw Object.assign(new Error('Certificat PostgreSQL invalide.'),{code:'INVALID_DATABASE_CA_CERT'})}
  return pem;
 }).join('');
}
function createPostgres(options={}){
 const context=new AsyncLocalStorage();
 let pool=options.pool;
 if(!pool){
  const value=options.connectionString||process.env.DATABASE_URL;
  if(!value)throw Error('DATABASE_URL doit être configurée dans les paramètres privés de l’hébergement.');
  const url=new URL(value);if(!['postgres:','postgresql:'].includes(url.protocol))throw Error('Adresse PostgreSQL invalide.');
  // Keep TLS verification mandatory; URL sslmode options must not override it.
  for(const key of ['sslmode','sslcert','sslkey','sslrootcert'])url.searchParams.delete(key);
  pool=new Pool({connectionString:url.toString(),max:2,connectionTimeoutMillis:15000,idleTimeoutMillis:20000,ssl:{rejectUnauthorized:true,...(process.env.DATABASE_CA_CERT?{ca:normalizeCaCertificate(process.env.DATABASE_CA_CERT)}:{})}});
  pool.on('error',err=>console.error('Connexion PostgreSQL interrompue:',err.code||err.name));
 }
 const query=(sql,values=[])=>{let index=0;sql=sql.replace(/\?/g,()=>'$'+(++index));return (context.getStore()||pool).query(sql,values)};
 const normalize=row=>{if(!row)return row;for(const name of ['expires','n'])if(typeof row[name]==='string')row[name]=Number(row[name]);return row};
 return {
  async exec(sql){await query(sql)},
  prepare(sql){return {async get(...values){return normalize((await query(sql,values)).rows[0])},async all(...values){return (await query(sql,values)).rows.map(normalize)},async run(...values){const result=await query(sql,values);return {changes:result.rowCount}}}},
  async transaction(fn){if(context.getStore())return fn();const client=await pool.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(527401286)');const result=await context.run(client,fn);await client.query('COMMIT');return result}catch(err){await client.query('ROLLBACK');throw err}finally{client.release()}},
  async close(){await pool.end()}
 };
}
module.exports={createPostgres,normalizeCaCertificate};
