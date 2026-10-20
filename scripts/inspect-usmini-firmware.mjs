import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseUsminiImage, publicFirmwareSummary } from "../src/firmware-image.mjs";

function usage() {
  console.error("Uso: node scripts/inspect-usmini-firmware.mjs <imagem.bin> [--json] [--extract <diretório>]");
  process.exit(2);
}

const args = process.argv.slice(2);
const source = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--extract");
if (!source) usage();
const extractIndex = args.indexOf("--extract");
const extractDir = extractIndex >= 0 ? args[extractIndex + 1] : null;
if (extractIndex >= 0 && !extractDir) usage();

const bytes = await fs.readFile(source);
const image = parseUsminiImage(bytes);
const summary = publicFirmwareSummary(image);

if (extractDir) {
  await fs.mkdir(extractDir, { recursive: true });
  for (const component of image.components) {
    const data = component.data || component.raw;
    if (!data?.length) continue;
    const filename = `${String(component.offset).padStart(8, "0")}-${component.name}.bin`;
    const destination = path.join(extractDir, filename);
    await fs.writeFile(destination, data);
    const digest = crypto.createHash("sha256").update(data).digest("hex");
    console.error(`${filename}: ${data.length} bytes, sha256=${digest}`);
  }
}

if (args.includes("--json")) {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.valid ? 0 : 1);
}

console.log(`USMINI ${summary.size} bytes  sha256=${summary.sha256}`);
console.log(`Protocolo ${summary.protocol}; ${summary.components.length} componentes; CRC ${summary.valid ? "válido" : "inválido"}`);
for (const component of summary.components) {
  console.log(`- ${component.name}: tipo ${component.type}, offset ${component.offset}, ${component.dataSize} bytes, sha256=${component.sha256}`);
  for (const segment of component.segments || []) console.log(`  segmento @${segment.dataOffset}: ${segment.size} bytes, CRC ${segment.crcValid ? "OK" : "ERRO"}`);
}
if (summary.trailing.size) {
  const marker = summary.trailing.platformMarker ? `, marcador ${summary.trailing.platformMarker.name} @${summary.trailing.platformMarker.offset}` : "";
  console.log(`Extensão opaca @${summary.trailing.offset}: ${summary.trailing.size} bytes${marker}`);
}
process.exit(summary.valid ? 0 : 1);
