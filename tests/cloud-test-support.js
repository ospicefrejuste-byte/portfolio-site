"use strict";
const crypto=require('node:crypto');const {Pool}=require('pg');
const {createPostgres}=require('../lib/postgres');
const {createApplication:cloud}=require('../lib/cloud-application');
const schemas=new Map();
async function createApplication(options={}){
 const connectionString=process.env.CRS_TEST_DATABASE_URL;
 if(!connectionString)throw Error('CRS_TEST_DATABASE_URL doit désigner une base PostgreSQL réservée aux tests.');
 const key=options.dataDir||'default';
 let schema=schemas.get(key);if(!schema){schema='crs_test_'+crypto.randomBytes(12).toString('hex');schemas.set(key,schema);const admin=new Pool({connectionString});try{await admin.query('CREATE SCHEMA '+schema)}finally{await admin.end()}}
 const pool=new Pool({connectionString,options:'-c search_path='+schema});
 return cloud({...options,setupToken:options.setupToken||'test-only-cloud-setup',database:createPostgres({pool})});
}
async function cleanup(){const connectionString=process.env.CRS_TEST_DATABASE_URL;const admin=new Pool({connectionString});try{for(const schema of schemas.values())await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE')}finally{await admin.end();schemas.clear()}}
module.exports={createApplication,cleanup};
