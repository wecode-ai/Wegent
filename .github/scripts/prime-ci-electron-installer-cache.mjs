import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { primeElectronInstallerCache } from "../../wework/scripts/lib/electron-installer-cache.mjs";

const run = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), "ci-electron-"));
const api = "https://api.github.com/repos/electron/electron/releases";

try {
  await primeElectronInstallerCache({
    electronPackageRoot: "wework/electron/node_modules/electron",
    downloadSourceArtifact: async ({ version, platform, arch }) => {
      const filename = `electron-v${version}-${platform}-${arch}.zip`;
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
} finally {
  await rm(temporary, { recursive: true, force: true });
}
