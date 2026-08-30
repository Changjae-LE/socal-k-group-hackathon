const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", "raffle-app", ".env");
const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const key = ((raw.match(/^SODAGIFT_API_KEY=(.*)$/m) || [])[1] || "").trim();
fs.writeFileSync(
  path.join(__dirname, "secrets.js"),
  `module.exports = { SODAGIFT_API_KEY: ${JSON.stringify(key)} };\n`,
);
console.log("functions/secrets.js written; key_set=" + Boolean(key));
