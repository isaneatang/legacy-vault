// Generates frontend/js/env.js with build-time configuration.
// On Vercel this runs automatically (see vercel.json buildCommand) using
// project environment variables. Locally it reads .env when present:
//     node scripts/gen-config.js
const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  const p = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadDotEnv();

const wcId = process.env.WC_PROJECT_ID || "";
const out = `// GENERATED FILE - do not edit by hand.
// Values come from the environment (.env locally, Vercel env vars in prod).
// Regenerate with: node scripts/gen-config.js
window.LV_ENV = { WC_PROJECT_ID: ${JSON.stringify(wcId)} };
`;
fs.writeFileSync(path.join(__dirname, "..", "frontend", "js", "env.js"), out);
console.log(`env.js written (WC_PROJECT_ID ${wcId ? "set" : "EMPTY"})`);
