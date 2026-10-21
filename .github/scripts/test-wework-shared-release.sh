#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
workflow="${1:-$repo_root/.github/workflows/wework-app.yml}"
repo="${GH_REPO:-${GITHUB_REPOSITORY:?Set GH_REPO or GITHUB_REPOSITORY}}"
export GH_REPO="$repo"
test_tag="wework-release-e2e-${GITHUB_RUN_ID:-local}-$(date +%s)-${RANDOM}"
temp_dir="$(mktemp -d)"
release_id=""
tag_created=false

cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n "$release_id" ]]; then
    gh api "repos/$repo/releases/$release_id" --method DELETE || result=1
  fi
  if [[ "$tag_created" == true ]]; then
    gh api "repos/$repo/git/refs/tags/$test_tag" --method DELETE || result=1
  fi
  rm -rf "$temp_dir"
  exit "$result"
}
trap cleanup EXIT

main_sha="$(gh api "repos/$repo/git/ref/heads/main" --jq '.object.sha')"
export RELEASE_SHA
RELEASE_SHA="$(gh api "repos/$repo/commits/$main_sha" --jq '.parents[0].sha')"
gh api "repos/$repo/git/refs" --method POST \
  --raw-field "ref=refs/tags/$test_tag" --raw-field "sha=$main_sha" >/dev/null
tag_created=true
jq -n --arg tag "$test_tag" '{
  tag_name: $tag, target_commitish: "main", draft: true, prerelease: true,
  name: "Isolated Wework release regression", body: "Temporary draft; no update assets."
}' > "$temp_dir/create.json"
release_id="$(gh api "repos/$repo/releases" --method POST \
  --input "$temp_dir/create.json" --jq '.id')"
printf 'Shared release preservation fixture\n' > "$temp_dir/existing-asset.txt"
gh release upload "$test_tag" "$temp_dir/existing-asset.txt"

snapshot() {
  gh api "repos/$repo/releases/$release_id" --jq \
    '{id, tag_name, target_commitish, name, body, draft, prerelease, assets}' | jq -S .
}
snapshot > "$temp_dir/before.json"

# Exercise the workflow's actual provisioning commands against the isolated draft.
RELEASE_E2E_TAG="$test_tag" ruby -r yaml -e '
  workflow = YAML.safe_load(File.read(ARGV.fetch(0)), aliases: true)
  step = workflow.fetch("jobs").fetch("publish").fetch("steps").find do |entry|
    entry["name"] == "Publish rolling update channels"
  end
  source = step.fetch("run")
  boundary = source.index(/^existing_component_assets=/)
  abort "Shared release provisioning boundary not found" unless boundary
  provisioning = source[0...boundary]
  abort "Shared release lookup not found" unless provisioning.include?("gh release view wework-updater")
  puts provisioning.gsub("wework-updater", ENV.fetch("RELEASE_E2E_TAG"))
' "$workflow" > "$temp_dir/provision.sh"
bash "$temp_dir/provision.sh"

snapshot > "$temp_dir/after.json"
if ! diff -u "$temp_dir/before.json" "$temp_dir/after.json"; then
  printf 'Existing shared release metadata or assets changed during provisioning\n' >&2
  exit 1
fi
printf 'Existing shared release is preserved when RELEASE_SHA points to an older commit\n'
