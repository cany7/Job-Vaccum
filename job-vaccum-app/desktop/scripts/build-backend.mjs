import { spawnSync } from "node:child_process";

const result = spawnSync("uv", ["run", "--locked", "pyinstaller", "../packaging/backend.spec", "--noconfirm",
  "--distpath", "../dist/backend", "--workpath", "../build/backend"], {
  cwd: new URL("../../backend/", import.meta.url), stdio: "inherit",
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
