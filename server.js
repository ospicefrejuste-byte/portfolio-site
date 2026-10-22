"use strict";
const { createApplication } = require("./lib/application");
(async () => {
  const instance = await createApplication();
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Port invalide.");
  const server = instance.app.listen(port, process.env.HOST || "0.0.0.0", () => console.log(`Ferme ADEOYE démarrée sur le port ${port}.`));
  let closing = false;
  async function close() {
    if (closing) return; closing = true;
    const timeout = setTimeout(() => { server.closeAllConnections(); }, 8000).unref();
    await new Promise(resolve => server.close(resolve)); clearTimeout(timeout); await instance.db.close();
  }
  process.once("SIGTERM", close); process.once("SIGINT", close);
})().catch(error => { console.error("Démarrage ADEOYE impossible :", error.code || error.name); process.exitCode = 1; });
