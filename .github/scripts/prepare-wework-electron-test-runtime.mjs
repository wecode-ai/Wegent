import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { prepareSharedElectronZip } from "../../wework/scripts/lib/electron-zip-cache.mjs";

const run = promisify(execFile);
const root = await realpath(resolve("wework/electron/node_modules/electron"));
const { version } = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const filename = `electron-v${version}-linux-x64.zip`;
const temporary = await mkdtemp(join(root, ".ci-electron-"));
const api = "https://api.github.com/repos/electron/electron/releases";
const dist = join(root, "dist");

try {
  const zipDir = await prepareSharedElectronZip({
    electronPackageRoot: root,
    environment: { WEWORK_ELECTRON_ZIP_DIR: join(temporary, "verified") },
    runtime: { platform: "linux", arch: "x64" },
    downloadArtifact: async () => {
      const { stdout } = await run("curl", [
        "--fail",
        "--silent",
        "--show-error",
        "--connect-timeout",
        "10",
        "--max-time",
        "30",
        `${api}/tags/v${version}`,
      ]);
      const asset = JSON.parse(stdout).assets.find(
        (item) => item.name === filename,
      );
      if (!Number.isSafeInteger(asset?.id) || asset.id <= 0) {
        throw new Error(
          `Official Electron release does not contain ${filename}`,
        );
      }
      const download = join(temporary, filename);
      await run("curl", [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--connect-timeout",
        "10",
        "--max-time",
        "240",
        "--header",
        "Accept: application/octet-stream",
        "--output",
        download,
        `${api}/assets/${asset.id}?download=1`,
      ]);
      return download;
    },
  });
  const extracted = join(temporary, "dist");
  await run("unzip", ["-q", join(zipDir, filename), "-d", extracted]);
  await access(join(extracted, "electron"), constants.X_OK);
  await rm(dist, { recursive: true, force: true });
  await rename(extracted, dist);
  await writeFile(join(root, "path.txt"), "electron");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
