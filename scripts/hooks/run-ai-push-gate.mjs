import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { acquireProcessLock } from "../../wework/scripts/lib/process-lock.mjs";

const commonDirectory = execFileSync("git", ["rev-parse", "--git-common-dir"], {
  encoding: "utf8",
}).trim();
const release = await acquireProcessLock(
  resolve(commonDirectory, "ai-push-gate.lock"),
  {
    onWait: () =>
      console.log(
        "[ai-push-gate] Waiting for another worktree to finish checks",
      ),
  },
);
try {
  process.exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(
      "bash",
      [resolve("scripts/hooks/ai-push-gate.sh"), ...process.argv.slice(2)],
      {
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? 1));
  });
} finally {
  await release();
}
