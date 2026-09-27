/**
 * Arma el sitio combinado en site/dist/:
 *   index.html            portada con el selector NFL 2024 | NFL 2026 (site/shell.html)
 *   nfl2024/…             snapshot de la edición 2024 (nfl2024/snapshot/dist)
 *   nfl2026/…             snapshot de la edición 2026 (nfl2026/snapshot/dist)
 *
 * Cada edición se exporta por separado con su propia base de datos:
 *   npm run 2024:export   ·   npm run 2026:export   ·   npm run site:build
 */
import { cp, mkdir, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "site", "dist");

async function size(dir) {
  let total = 0, files = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) { total += (await stat(path.join(e.parentPath, e.name))).size; files++; }
  }
  return { total, files };
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
for (const ed of ["2024", "2026"]) {
  const src = path.join(ROOT, `nfl${ed}`, "snapshot", "dist");
  try { await stat(path.join(src, "index.html")); } catch {
    throw new Error(`Falta nfl${ed}/snapshot/dist/index.html: corre primero npm run ${ed}:export`);
  }
  await cp(src, path.join(DIST, `nfl${ed}`), { recursive: true });
  const s = await size(path.join(DIST, `nfl${ed}`));
  console.log(`nfl${ed}/: ${s.files} archivos · ${(s.total / 1024 / 1024).toFixed(1)} MB`);
}
await writeFile(path.join(DIST, "index.html"), await readFile(path.join(ROOT, "site", "shell.html"), "utf8"));
const all = await size(DIST);
console.log(`Sitio listo en site/dist/: ${all.files} archivos · ${(all.total / 1024 / 1024).toFixed(1)} MB`);
