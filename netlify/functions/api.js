"use strict";
const path = require("node:path");
const serverless = require("serverless-http");
const { options: serverlessOptions, normalizeEvent } = require("../../lib/serverless");
const { createApplication } = require("../../lib/application");
let ready;
exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  try {
    if (!process.env.ADEOYE_DATABASE_URL || !process.env.ADEOYE_SETUP_TOKEN || !process.env.ADEOYE_PUBLIC_ORIGIN) throw Error("Configuration ADEOYE incomplète");
    if (!ready) ready = createApplication({ production: true, publicOrigin: process.env.ADEOYE_PUBLIC_ORIGIN, publicDir: path.join(process.cwd(), "public") }).then(instance => serverless(instance.app, serverlessOptions)).catch(error => { ready = null; throw error; });
    return await (await ready)(normalizeEvent(event), context);
  } catch (error) {
    console.error("Initialisation ADEOYE impossible :", error.code || error.name);
    return { statusCode: 503, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, body: JSON.stringify({ error: "La plateforme est momentanément indisponible. Le responsable doit vérifier la configuration de l’hébergement de la ferme." }) };
  }
};
