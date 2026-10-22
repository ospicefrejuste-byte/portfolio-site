"use strict";
const { isIP } = require("node:net");
const options = { binary: ["application/pdf"] };
function normalizeEvent(event) {
  const prefix = "/.netlify/functions/api";
  const pathname = (event.path || "/").startsWith(prefix) ? event.path.slice(prefix.length) || "/" : event.path;
  const headers = event.headers || {};
  const candidate = event.requestContext?.identity?.sourceIp || headers["x-nf-client-connection-ip"] || headers["X-Nf-Client-Connection-Ip"];
  const sourceIp = typeof candidate === "string" && isIP(candidate) ? candidate : "unknown";
  return { ...event, path: pathname, requestContext: { ...event.requestContext, identity: { ...event.requestContext?.identity, sourceIp } } };
}
module.exports = { options, normalizeEvent };
