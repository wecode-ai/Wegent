import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installDiagnostic } from "./pnpm-install-report.mjs";

test("retains install failure metadata without arbitrary messages, URLs or credentials", () => {
  const event = {
    name: "pnpm:request-retry",
    url: "https://user:fixture-secret@registry.npmjs.org/pkg?token=fixture-secret",
    attempt: 2,
    error: {
      code: "ERR_PNPM_FETCH_503",
      statusCode: 503,
      cause: { code: "ECONNRESET" },
      message: "fixture-secret",
      stack: "fixture-secret",
    },
  };
  const result = JSON.parse(JSON.stringify(installDiagnostic(event, "/repo")));
  assert.deepEqual(result, {
    name: "pnpm:request-retry",
    errorCode: "ERR_PNPM_FETCH_503",
    causeCode: "ECONNRESET",
    statusCode: 503,
    attempt: 2,
    hostname: "registry.npmjs.org",
  });
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|token|https:/);
  assert.equal(
    installDiagnostic(
      { name: "pnpm:lifecycle", line: "fixture-secret" },
      "/repo",
    ),
    null,
  );
});

test("identifies the failing workspace lifecycle without capturing script output", () => {
  const result = JSON.parse(
    JSON.stringify(
      installDiagnostic(
        {
          name: "pnpm:lifecycle",
          wd: "/repo/frontend",
          stage: "postinstall",
          exitCode: 1,
          line: "fixture-secret",
        },
        "/repo",
      ),
    ),
  );
  assert.deepEqual(result, {
    name: "pnpm:lifecycle",
    project: "frontend",
    stage: "postinstall",
    exitCode: 1,
  });
  assert.equal(
    installDiagnostic({ name: "pnpm:lifecycle", exitCode: 0 }, "/repo"),
    null,
  );
});

test("reporting preserves the original pipeline exit code and output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wework-pnpm-report-"));
  try {
    const producer = join(directory, "producer.mjs");
    const report = join(directory, "report.json");
    const output = `${JSON.stringify({ name: "pnpm", level: "error", code: "ERR_PNPM_FETCH_503", message: "fixture-secret" })}\n`;
    await writeFile(
      producer,
      `process.stdout.write(${JSON.stringify(output)}); process.exit(Number(process.argv[2]))`,
    );
    const run = (exitCode, destination) =>
      spawnSync(
        "bash",
        [
          "-o",
          "pipefail",
          "-c",
          '"$1" "$2" "$3" | "$1" "$4" "$5"',
          "pnpm-report-test",
          process.execPath,
          producer,
          String(exitCode),
          new URL("./pnpm-install-report.mjs", import.meta.url).pathname,
          destination,
        ],
        { encoding: "utf8" },
      );
    const failed = run(17, report);
    assert.equal(failed.status, 17);
    assert.equal(failed.stdout, output);
    const diagnostics = JSON.parse(await readFile(report, "utf8"));
    assert.equal(diagnostics.events[0].code, "ERR_PNPM_FETCH_503");
    assert.doesNotMatch(JSON.stringify(diagnostics), /fixture-secret/);
    for (const status of [0, 17]) {
      const unavailableReport = run(
        status,
        join(directory, "missing", "report.json"),
      );
      assert.equal(unavailableReport.status, status);
      assert.match(
        unavailableReport.stderr,
        /Unable to save pnpm install diagnostics/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
