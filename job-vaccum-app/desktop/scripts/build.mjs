import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

for (const args of [["typescript/bin/tsc", "-p", "tsconfig.electron.json"], ["vite/bin/vite.js", "build"]]) {
  const result = spawnSync(process.execPath, ["node_modules/" + args[0], ...args.slice(1)], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await mkdir("dist/electron", { recursive: true });
await writeFile("dist/electron/package.json", JSON.stringify({ type: "commonjs" }) + "\n");
