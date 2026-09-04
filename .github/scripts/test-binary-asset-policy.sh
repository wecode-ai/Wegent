#!/usr/bin/env bash
# Regression tests for the binary asset policy workflow and scripts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKFLOW="$PROJECT_ROOT/.github/workflows/binary-asset-policy.yml"
SCANNER="$PROJECT_ROOT/.github/scripts/check-binary-assets.sh"
VERIFIER="$PROJECT_ROOT/.github/scripts/verify-binary-asset-approval.cjs"
TMP_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

require_line() {
    local file="$1"
    local pattern="$2"

    if ! grep -Fq "$pattern" "$file"; then
        echo "Expected line in $file: $pattern" >&2
        exit 1
    fi
}

mkdir -p "$TMP_DIR/target/src" "$TMP_DIR/target/assets"
printf 'export const value = 1\n' > "$TMP_DIR/target/src/value.ts"
: > "$TMP_DIR/target/src/__init__.py"
printf '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n' > "$TMP_DIR/target/assets/icon.svg"
printf 'plain documentation\n' > "$TMP_DIR/target/README.md"
printf 'PK\003\004binary archive\000' > "$TMP_DIR/target/assets/archive.zip"

node -e '
const fs = require("fs")
fs.writeFileSync(process.argv[1], JSON.stringify([
  "src/value.ts",
  "src/__init__.py",
  "assets/icon.svg",
  "assets/archive.zip",
  "README.md",
  "assets/deleted.png",
]))
' "$TMP_DIR/changed-files.json"

scanner_output="$(
    bash "$SCANNER" \
        "$TMP_DIR/changed-files.json" \
        "$TMP_DIR/target" \
        "$TMP_DIR/report.tsv"
)"

grep -Fq "requires_approval=true" <<<"$scanner_output"
grep -Fq $'assets/icon.svg\timage\timage/svg+xml' "$TMP_DIR/report.tsv"
grep -Fq $'assets/archive.zip\tbinary\t' "$TMP_DIR/report.tsv"
if grep -Fq "src/value.ts" "$TMP_DIR/report.tsv" ||
    grep -Fq "src/__init__.py" "$TMP_DIR/report.tsv" ||
    grep -Fq "README.md" "$TMP_DIR/report.tsv" ||
    grep -Fq "deleted.png" "$TMP_DIR/report.tsv"; then
    echo "Scanner reported a text or deleted file." >&2
    exit 1
fi

printf '["src/value.ts","README.md"]' > "$TMP_DIR/text-files.json"
text_output="$(
    bash "$SCANNER" \
        "$TMP_DIR/text-files.json" \
        "$TMP_DIR/target" \
        "$TMP_DIR/text-report.tsv"
)"
grep -Fq "requires_approval=false" <<<"$text_output"
test ! -s "$TMP_DIR/text-report.tsv"

require_line "$WORKFLOW" "pull_request_target:"
require_line "$WORKFLOW" "pull_request_review:"
require_line "$WORKFLOW" "merge_group:"
require_line "$WORKFLOW" "pull-requests: read"
require_line "$WORKFLOW" "path: trusted-policy"
require_line "$WORKFLOW" "github.event.pull_request.base.ref == 'main'"
require_line "$WORKFLOW" "Check trusted binary asset policy availability"
require_line "$WORKFLOW" "steps.trusted-policy.outputs.available == 'true'"
require_line "$WORKFLOW" "allow-unsafe-pr-checkout: true"
require_line "$WORKFLOW" "verify-binary-asset-approval.cjs"
require_line "$VERIFIER" "review.commit_id !== headSha"
require_line "$VERIFIER" "response.data.permission === 'admin'"

node - "$VERIFIER" <<'NODE'
const assert = require('assert')
const verifyApproval = require(process.argv[2])

function createGithub({ reviews, permissions }) {
  return {
    paginate: async () => reviews,
    rest: {
      pulls: { listReviews: Symbol('listReviews') },
      repos: {
        getCollaboratorPermissionLevel: async ({ username }) => ({
          data: { permission: permissions[username] ?? 'read' },
        }),
      },
    },
  }
}

async function run({ reviews, permissions = {}, headSha = 'head' }) {
  const failures = []
  await verifyApproval({
    github: createGithub({ reviews, permissions }),
    context: {
      repo: { owner: 'owner', repo: 'repo' },
      payload: { pull_request: { number: 1, head: { sha: headSha } } },
    },
    core: {
      info() {},
      setFailed(message) {
        failures.push(message)
      },
    },
  })
  return failures
}

;(async () => {
  assert.strictEqual(
    (await run({
      reviews: [
        { id: 1, commit_id: 'head', state: 'APPROVED', user: { login: 'admin' } },
      ],
      permissions: { admin: 'admin' },
    })).length,
    0,
  )

  assert.strictEqual(
    (await run({
      reviews: [
        { id: 1, commit_id: 'old', state: 'APPROVED', user: { login: 'admin' } },
      ],
      permissions: { admin: 'admin' },
    })).length,
    1,
  )

  assert.strictEqual(
    (await run({
      reviews: [
        { id: 1, commit_id: 'head', state: 'APPROVED', user: { login: 'admin' } },
        {
          id: 2,
          commit_id: 'head',
          state: 'CHANGES_REQUESTED',
          user: { login: 'admin' },
        },
      ],
      permissions: { admin: 'admin' },
    })).length,
    1,
  )

  assert.strictEqual(
    (await run({
      reviews: [
        { id: 1, commit_id: 'head', state: 'APPROVED', user: { login: 'writer' } },
      ],
      permissions: { writer: 'write' },
    })).length,
    1,
  )
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
NODE

echo "binary asset policy regression tests passed"
