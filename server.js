"use strict";
const { createApplication } = require("./lib/application");
const { app, db, dataDir, initialized } = createApplication();
const server = app.listen(process.env.PORT || 3000, "0.0.0.0", () => {
  console.log("Serveur de cours de renforcement démarré.");
  if (!initialized())
    console.log(
      `Installation nécessaire : ouvrez /installation.html et utilisez le code du fichier ${dataDir}/setup-token ou la variable CRS_SETUP_TOKEN configurée. Ne partagez pas ce code.`,
    );
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
