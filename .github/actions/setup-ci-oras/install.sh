#!/usr/bin/env bash
set -euo pipefail

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    # Official ORAS 1.3.1 linux/amd64 image, /bin/oras layer.
    repository=oras-project/oras
    digest=09ec5272896fa60caae390a4a64dff0288447f20bba1456f23879eba59e2236b
    member=bin/oras
    ;;
  Darwin-arm64)
    # Homebrew Core ORAS 1.3.1 arm64_sequoia bottle.
    repository=homebrew/core/oras
    digest=6d638010fe839ef19033aa35d254c4ba246112a0699d682bf426976d5401b617
    member=oras/1.3.1/bin/oras
    ;;
  *)
    printf 'Unsupported ORAS runner: %s-%s\n' "$(uname -s)" "$(uname -m)" >&2
    exit 1
    ;;
esac

directory="$(mktemp -d "${RUNNER_TEMP:?}/oras.XXXXXX")"
archive="$directory/oras.tar.gz"
trap 'rm -f "$archive"' EXIT
token="$(curl --fail --silent --show-error --connect-timeout 10 --max-time 30 \
  "https://ghcr.io/token?service=ghcr.io&scope=repository:$repository:pull" | \
  node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).token')"
curl --fail --silent --show-error --location --connect-timeout 10 --max-time 90 \
  --header "Authorization: Bearer $token" \
  "https://ghcr.io/v2/$repository/blobs/sha256:$digest" --output "$archive"
unset token
if [[ "$repository" == oras-project/oras ]]; then
  printf '%s  %s\n' "$digest" "$archive" | sha256sum --check
else
  printf '%s  %s\n' "$digest" "$archive" | shasum -a 256 --check
fi
tar -xOzf "$archive" "$member" > "$directory/oras"
chmod 0755 "$directory/oras"
"$directory/oras" version
printf '%s\n' "$directory" >> "${GITHUB_PATH:?}"
