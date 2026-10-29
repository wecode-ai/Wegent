import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const component = process.argv[2];
if (!["executor", "backend-rs"].includes(component)) {
  throw new Error("Expected executor or backend-rs");
}
const startedAt = Date.now();
let fileCount = 0;

// Preserve hashFiles' pattern order and depth-first file order without globbing
// the workspace. CI checks out these tracked source inputs before computing keys.
const groups = [
  `${component}/Cargo.toml`,
  `${component}/Cargo.lock`,
  `:(glob)${component}/src/**/*.rs`,
  ...(component === "executor" ? ["executor/vendor"] : []),
];
const result = createHash("sha256");
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
    result.update(createHash("sha256").update(readFileSync(file)).digest());
    fileCount++;
  }
}
console.error(
  `Hashed ${fileCount} ${component} inputs in ${Date.now() - startedAt}ms`,
);
process.stdout.write(`${result.digest("hex")}\n`);
