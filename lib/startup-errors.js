"use strict";
function requireProductionConfiguration(environment) {
  const missing = ["ADEOYE_DATABASE_URL", "ADEOYE_SETUP_TOKEN", "ADEOYE_PUBLIC_ORIGIN"].filter(name => !environment[name]?.trim());
  if (missing.length) throw Object.assign(new Error("Configuration ADEOYE incomplète."), { code: "ADEOYE_CONFIG_MISSING", missing });
}
function startupDiagnostic(error) {
  const cause = error?.code;
  if (cause === "ADEOYE_CONFIG_MISSING") return { code: "ADEOYE_CONFIG_MISSING", message: "Un paramètre de démarrage manque. Vérifiez les variables ADEOYE dans le contexte Production de Netlify, disponibles aux Functions." };
  if (cause === "ADEOYE_PUBLIC_ORIGIN_INVALID") return { code: "ADEOYE_PUBLIC_ORIGIN_INVALID", message: "L’adresse publique du site est invalide. Vérifiez ADEOYE_PUBLIC_ORIGIN dans Netlify." };
  if (["ADEOYE_DATABASE_URL_INVALID", "ERR_INVALID_URL"].includes(cause)) return { code: "ADEOYE_DATABASE_URL_INVALID", message: "L’adresse de connexion à la base est invalide. Vérifiez ADEOYE_DATABASE_URL dans Netlify." };
  if (["28P01", "28000"].includes(cause)) return { code: "ADEOYE_DB_AUTH", message: "La base a refusé la connexion. Vérifiez l’adresse et le mot de passe de la base Supabase ADEOYE dans Netlify." };
  if (["ADEOYE_CA_INVALID", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(cause)) return { code: "ADEOYE_DB_TLS", message: "Le certificat de la connexion à la base n’a pas pu être vérifié. Le journal de la fonction api indiquera le contrôle refusé." };
  if (["ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET"].includes(cause) || /timeout|timed out|connection terminated/i.test(error?.message || "")) return { code: "ADEOYE_DB_NETWORK", message: "La base est momentanément inaccessible. Vérifiez son adresse de connexion et que le projet Supabase est actif." };
  if (cause === "42501") return { code: "ADEOYE_DB_ACCESS", message: "Le compte de connexion à la base ne dispose pas des droits nécessaires. Vérifiez les paramètres du projet Supabase ADEOYE." };
  return { code: "ADEOYE_STARTUP_ERROR", message: "La plateforme est momentanément indisponible. Consultez le journal de la fonction api dans Netlify pour identifier la cause." };
}
module.exports = { requireProductionConfiguration, startupDiagnostic };
