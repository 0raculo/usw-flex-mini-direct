import fs from "node:fs/promises";
import path from "node:path";

const [source, destination = "./data"] = process.argv.slice(2);
if (!source) {
  console.error("Uso: node scripts/import-baseline.mjs <system-cfg.txt> [diretorio-de-dados]");
  process.exit(1);
}
const systemCfg = await fs.readFile(source, "utf8");
if (!systemCfg.includes("switch.managementvlan=") || !systemCfg.includes("switch.port.1.")) {
  throw new Error("O ficheiro não parece ser um system_cfg de um switch UniFi.");
}
await fs.mkdir(destination, { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(destination, "baseline.json"), JSON.stringify({
  importedAt: new Date().toISOString(),
  systemCfg
}, null, 2), { mode: 0o600 });
console.log(`Baseline importada para ${path.resolve(destination, "baseline.json")}.`);
