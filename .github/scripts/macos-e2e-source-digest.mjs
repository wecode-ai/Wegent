import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const component = process.argv[2];
if (!["executor", "backend-rs"].includes(component)) {
  throw new Error("Expected executor or backend-rs");
}
const startedAt = Date.now();
let fileCount = 0;

// Embedded JSON, SDK sources and shared prompts affect the compiled binary too.
// Use tracked inputs so build outputs cannot accidentally invalidate the key.
const groups = [
  `${component}/Cargo.toml`,
  `${component}/Cargo.lock`,
  `${component}/src`,
  "shared/rust",
  `${component}/crates`,
  ...(component === "executor"
    ? [
        "executor/vendor",
        "sdk/plugin-auth",
        "sdk/plugin-creator",
        "shared/assets",
        "shared/protocol",
      ]
    : []),
  ".github/ci/rust-toolchain",
  ".github/actions/setup-rust-cache/action.yml",
  ".github/scripts/build-macos-e2e-runtimes.sh",
];
const result = createHash("sha256").update("macos-arm64-e2e-v2\n");
for (const pattern of groups) {
  const files = execFileSync("git", ["ls-files", "-z", "--", pattern], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => {
      const a = left.split("/");
      const b = right.split("/");
      for (let index = 0; index < Math.min(a.length, b.length); index++) {
        if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
      }
      return a.length - b.length;
    });
  if (!files.length) throw new Error(`No tracked source inputs for ${pattern}`);
  for (const file of files) {
    result.update(file).update("\0").update(readFileSync(file)).update("\0");
    fileCount++;
  }
}
console.error(
  `Hashed ${fileCount} ${component} inputs in ${Date.now() - startedAt}ms`,
);
process.stdout.write(`${result.digest("hex")}\n`);
