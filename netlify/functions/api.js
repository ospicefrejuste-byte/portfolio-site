"use strict";
const path=require('node:path');
const serverless=require('serverless-http');
const {createApplication}=require('../../lib/cloud-application');
let ready;
exports.handler=async(event,context)=>{
 context.callbackWaitsForEmptyEventLoop=false;
 if(!ready)ready=createApplication({production:true,publicDir:path.join(process.cwd(),'public')}).then(({app})=>serverless(app)).catch(err=>{ready=undefined;throw err});
 try{
  const handler=await ready;
  const prefix='/.netlify/functions/api';
  const pathname=(event.path||'/').startsWith(prefix)?event.path.slice(prefix.length)||'/':event.path;
  const headers=event.headers||{};
  const sourceIp=event.requestContext?.identity?.sourceIp||headers['x-nf-client-connection-ip']||headers['X-Nf-Client-Connection-Ip']||String(headers['x-forwarded-for']||'').split(',').at(-1).trim()||'unknown';
  return await handler({...event,path:pathname,requestContext:{...event.requestContext,identity:{...event.requestContext?.identity,sourceIp}}},context);
 }catch(err){console.error('Initialisation du serveur impossible:',err.code||err.name);return {statusCode:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({error:'Le serveur est indisponible. Vérifiez les paramètres de la base de données et du compte superviseur dans Netlify.'})}}
};
