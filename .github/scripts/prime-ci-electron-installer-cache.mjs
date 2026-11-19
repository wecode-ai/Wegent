import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { primeElectronInstallerCache } from "../../wework/scripts/lib/electron-installer-cache.mjs";

const run = promisify(execFile);
const temporary = await mkdtemp(join(tmpdir(), "ci-electron-"));

try {
  await primeElectronInstallerCache({
    electronPackageRoot: "wework/electron/node_modules/electron",
    downloadSourceArtifact: async ({ version, platform, arch }) => {
      const filename = `electron-v${version}-${platform}-${arch}.zip`;
      const download = join(temporary, filename);
      await run(
        "gh",
        [
          "release",
          "download",
          `v${version}`,
          "--repo",
          "electron/electron",
          "--pattern",
          filename,
          "--dir",
          temporary,
        ],
        { timeout: 240_000 },
      );
      return download;
    },
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
