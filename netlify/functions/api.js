"use strict";
const path = require("node:path");
const serverless = require("serverless-http");
const { options: serverlessOptions, normalizeEvent } = require("../../lib/serverless");
const { createApplication } = require("../../lib/application");
const { requireProductionConfiguration, startupDiagnostic } = require("../../lib/startup-errors");
let ready;
exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  try {
    requireProductionConfiguration(process.env);
    if (!ready) ready = createApplication({ production: true, publicOrigin: process.env.ADEOYE_PUBLIC_ORIGIN, publicDir: path.join(process.cwd(), "public") }).then(instance => serverless(instance.app, serverlessOptions)).catch(error => { ready = null; throw error; });
    return await (await ready)(normalizeEvent(event), context);
  } catch (error) {
    const diagnostic = startupDiagnostic(error);
    console.error("Initialisation ADEOYE impossible :", diagnostic.code, error.code || error.name, ...(error.missing ? [error.missing.join(", ")] : []));
    return { statusCode: 503, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify({ error: diagnostic.message + " (" + diagnostic.code + ")", code: diagnostic.code }) };
  }
};
