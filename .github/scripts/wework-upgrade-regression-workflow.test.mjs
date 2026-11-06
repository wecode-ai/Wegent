import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const workflow = JSON.parse(
  execFileSync(
    "ruby",
    [
      "-ryaml",
      "-rjson",
      "-e",
      "puts JSON.generate(YAML.load_file(ARGV[0]))",
      new URL("../workflows/wework-upgrade-regression.yml", import.meta.url)
        .pathname,
    ],
    { encoding: "utf8" },
  ),
);

test("native regression jobs consume separately built complete source and target artifacts", () => {
  const { produce, verify } = workflow.jobs;
  assert.equal(workflow.permissions.contents, "read");
  assert.deepEqual(produce.strategy.matrix.role, ["source", "target"]);
  assert.deepEqual(produce.strategy.matrix.runner, [
    "macos-15",
    "windows-2022",
  ]);
  assert.deepEqual(
    verify.strategy.matrix.include.map((item) => item.platform),
    ["macos", "windows"],
  );
  assert.equal(verify.needs, "produce");
  assert.ok(
    produce.steps.some(
      (step) => step.run === "pnpm --filter wework ai:verify:electron:build",
    ),
  );
  const commands = verify.steps.map((step) => step.run ?? "").join("\n");
  assert.ok(
    verify.steps.some(
      (step) =>
        step.run ===
        "pnpm --dir wework/electron install --frozen-lockfile --ignore-scripts",
    ),
    "The consumer requires the separately locked YAML and Socket.IO driver dependencies",
  );
  assert.match(commands, /prepare-upgrade-regression\.mjs pair/);
  assert.match(commands, /e2e:desktop -- --segment app-update-retry/);
  assert.doesNotMatch(commands, /build:|sync-desktop-release-version|codesign/);
  assert.equal(
    verify.steps.filter((step) => step.uses === "actions/download-artifact@v4")
      .length,
    2,
  );
});
