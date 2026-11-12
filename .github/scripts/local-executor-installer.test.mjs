import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const releases = JSON.parse(
  readFileSync(
    new URL("../fixtures/executor-platform-releases.json", import.meta.url),
    "utf8",
  ),
);
const source = readFileSync(
  new URL("../../executor/scripts/local_executor_install.sh", import.meta.url),
  "utf8",
);
const functions = [
  "fetch_url",
  "resolve_latest_platform_version",
  "get_download_url",
]
  .map((name) => {
    const definition = source.match(
      new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"),
    );
    assert.ok(definition, `Missing installer function ${name}`);
    return definition[0];
  })
  .join("\n");

function resolve(
  pages,
  {
    version = "",
    fail = false,
    platform = "macos-arm64",
    wgetOnly = false,
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "wegent-installer-releases-"));
  const fixtures = join(directory, "pages.json");
  const requests = join(directory, "requests");
  writeFileSync(fixtures, JSON.stringify(pages));
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
        set -euo pipefail
        GITHUB_REPO=wecode-ai/Wegent
        BINARY_NAME=wegent-executor
        PLATFORM="$INSTALLER_TEST_PLATFORM"
        VERSION="$INSTALLER_TEST_VERSION"
        print_info() { :; }
        print_error() { printf '%s\\n' "$*" >&2; }
        fixture_response() {
          node -e '
            const fs = require("node:fs")
            const url = process.argv.at(-1)
            fs.appendFileSync(process.env.INSTALLER_TEST_REQUESTS, url + "\\n")
            if (process.env.INSTALLER_TEST_FAIL === "true") process.exit(7)
            const pages = JSON.parse(fs.readFileSync(process.env.INSTALLER_TEST_FIXTURES, "utf8"))
            const page = Number(new URL(url).searchParams.get("page"))
            process.stdout.write(JSON.stringify(pages[page - 1] ?? []))
          ' -- "$@"
        }
        curl() { fixture_response "$@"; }
        wget() { printf 'fixture wget selected\\n' >&2; fixture_response "$@"; }
        command() {
          if [[ "$INSTALLER_TEST_WGET_ONLY" == true && "$1" == -v && "$2" == curl ]]; then
            return 1
          fi
          builtin command "$@"
        }
        ${functions}
        get_download_url
        printf '%s' "$DOWNLOAD_URL"
      `,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          INSTALLER_TEST_VERSION: version,
          INSTALLER_TEST_PLATFORM: platform,
          INSTALLER_TEST_FAIL: String(fail),
          INSTALLER_TEST_WGET_ONLY: String(wgetOnly),
          INSTALLER_TEST_FIXTURES: fixtures,
          INSTALLER_TEST_REQUESTS: requests,
        },
      },
    );
    return {
      ...result,
      requests: existsSync(requests)
        ? readFileSync(requests, "utf8").trim().split("\n")
        : [],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const platform of [
  "macos-arm64",
  "macos-amd64",
  "linux-arm64",
  "linux-amd64",
]) {
  test(`Unix installer selects the stable platform release for ${platform}`, () => {
    const result = resolve([releases], { platform });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      `https://github.com/wecode-ai/Wegent/releases/download/v2.0.25/wegent-executor-${platform}`,
    );
    assert.equal(result.requests.length, 1);
  });
}

test("Unix installer paginates past desktop releases", () => {
  const result = resolve([
    Array.from({ length: 100 }, () => releases[0]),
    releases,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\/download\/v2\.0\.25\//);
  assert.equal(result.requests.length, 2);
  assert.match(result.requests[1], /page=2$/);
});

test("Unix installer keeps wget-only hosts supported", () => {
  const result = resolve([releases], { wgetOnly: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\/download\/v2\.0\.25\//);
  assert.match(result.stderr, /fixture wget selected/);
});

test("Unix installer preserves an explicit version without querying the release catalog", () => {
  const result = resolve([], { version: "v1.2.3" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\/download\/v1\.2\.3\//);
  assert.deepEqual(result.requests, []);
});

test("Unix installer fails when no stable platform release exists", () => {
  const result = resolve([[releases[0], releases[1], releases[2]]]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No stable Wegent platform release/);
  assert.equal(result.requests.length, 1);
});

test("Unix installer reports a missing artifact instead of installing an older release", () => {
  const missing = releases.map((release) =>
    release.tag_name === "v2.0.25" ? { ...release, assets: [] } : release,
  );
  const result = resolve([missing]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /v2\.0\.25 has no wegent-executor-macos-arm64/);
  assert.equal(result.requests.length, 1);
});

test("Unix installer preserves release catalog transport errors", () => {
  const result = resolve([releases], { fail: true });
  assert.notEqual(result.status, 0);
  assert.equal(result.requests.length, 1);
  assert.equal(result.stdout, "");
});
