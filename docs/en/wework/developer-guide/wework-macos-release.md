---
sidebar_position: 27
---

# Wework macOS Release

English | [简体中文](../../zh/developer-guide/wework-macos-release.md)

The Wework macOS app uses the Tauri updater for automatic upgrades. Local or standalone releases are handled by `wework/scripts/release-mac-app.sh`, while GitHub Releases are built and published by `.github/workflows/wework-app.yml`.

## Release Model

- The default build target is `universal-apple-darwin`, producing one installer that supports both Apple Silicon and Intel Macs.
- The updater manifest includes both `darwin-aarch64` and `darwin-x86_64`; both platform entries can point to the same universal archive.
- `src-tauri/tauri.conf.json` does not store the update service URL or updater public key. Both the local release script and GitHub Actions use `wework/scripts/generate-release-config.mjs` to create a temporary Tauri config that injects release parameters while preserving the complete `bundle.resources` list from the base config. Tauri config overrides replace resource arrays as a whole, so release paths must not maintain a separate incomplete resources list.
- Updater private keys and publish tokens are read only from environment variables or local files and must not be committed.
- Codex CLI is not compiled locally. Before building, `wework/scripts/prepare-codex-binary.mjs` downloads the npm tarball pinned by `wework/codex-binaries.lock.json`, verifies its SHA-512 integrity, and bundles it as a Tauri resource.

## Bundled Codex Binary

The Wework desktop package includes Codex CLI directly, so users do not need to install it on first launch. The version and per-platform tarball checksums are pinned in `wework/codex-binaries.lock.json`.

The current pin is stable Codex `0.147.0`. An upgrade must update every
supported platform's npm package version, official registry tarball URL, and
SHA-512 integrity value together; do not replace the binary inside an already
signed app bundle. Prepare the sidecar again through a release build, then
package and code-sign the application.

Local builds prepare the Codex binary for the current target automatically:

```bash
pnpm --filter wework run prepare:codex
```

macOS universal builds prepare both Apple Silicon and Intel binaries:

```bash
cd wework
WEWORK_CODEX_TARGET=universal-apple-darwin pnpm run prepare:codex
```

The Codex tarball and extracted binaries are cached in a user-level directory so multiple worktrees reuse the same copy. On macOS, the default directory is `~/Library/Caches/wegent/codex`; set `WEGENT_CODEX_CACHE_DIR` to customize it. Development preparation creates links under `src-tauri/binaries/codex`, while release builds automatically use `--materialize` to place real files in the worktree for Tauri packaging and code signing.

Release builds verify the target Codex binary in `wework/src-tauri/build.rs`; the build fails if it is missing. At runtime, Wework injects the bundled Codex path into the local executor sidecar:

- `CODEX_BINARY_PATH`
- `CODEX_MANAGED_PACKAGE_ROOT`

If the user explicitly sets `CODEX_BINARY_PATH` or `CODEX_BIN`, Wework does not override that configuration.

## Environment Variables

Set these variables in the current shell before publishing:

```bash
export WEWORK_UPDATE_BASE_URL=https://example.com/wework/update
export WEWORK_UPDATE_PUBLISH_TOKEN=...
export TAURI_UPDATER_PUBKEY=...
```

The updater private key can be provided directly through `TAURI_SIGNING_PRIVATE_KEY`, or through the default local file path `~/.tauri/wework-updater.key`:

```bash
export TAURI_SIGNING_PRIVATE_KEY=...
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=...
```

Production releases also require Developer ID signing and Apple notarization:

```bash
export MACOS_APP_SIGN_IDENTITY="Developer ID Application: Example (TEAMID)"
export MACOS_NOTARY_PROFILE=wework-notary
```

Alternatively, provide an Apple ID, Team ID, and app-specific password so the script can create the notary profile:

```bash
export APPLE_BUILD_ID=...
export APPLE_BUILD_TEAM_ID=...
export APPLE_BUILD_PASSWORD=...
```

## Local Verification

Local verification writes a local updater directory. The default local update URL is `http://127.0.0.1:8787/dist/wework`:

```bash
cd wework
scripts/release-mac-app.sh --target local --version 0.1.99 --notes "Local verification."
```

To validate local updater behavior, serve the script output directory:

```bash
python3 -m http.server 8787 --directory src-tauri/target/release/local-update-server
```

## Window Surfaces

The Wework main window and detached workspace windows must use opaque Tauri
windows that are fully covered by the WebView theme surface. Do not enable
`transparent`, `windowEffects`, or native vibrancy materials for these windows.
Transparent window edges are composed differently across macOS versions and
graphics environments, which can expose the desktop or appear as translucent
or gray borders.

The system drag panel and Popout Window are separate lightweight overlays and
are not covered by this rule. Changes to ordinary window backgrounds, title
bars, or creation options must verify both the main window and detached
workspace windows and retain automated assertions that prevent native
transparency from being re-enabled.

## Tauri Dependency Upgrades

Update the Rust core dependencies and frontend toolchain together so development, testing, and release builds do not use different Tauri versions:

- Update `tauri` and a compatible `tauri-build` in `wework/src-tauri/Cargo.toml`, then refresh `wework/src-tauri/Cargo.lock`.
- Update `@tauri-apps/api` and `@tauri-apps/cli` in `wework/package.json`, then refresh the repository-root `pnpm-lock.yaml`.
- Tauri plugins are released independently and do not need to share the core package version. Upgrade only plugins that are compatible with the selected core version and whose changes are needed.
- After upgrading, run the Wework TypeScript type check, Vitest suite, Rust tests, and formatting checks. When the change affects windows, tray behavior, IPC, the asset protocol, or packaging, also use `pnpm --filter wework ai:verify` to start an isolated real Tauri application; browser-only or mocked tests are not sufficient.

When multiple worktrees run desktop verification concurrently, assign a distinct `WEWORK_PORT` to each instance. The shared Cargo target serializes compilation, and the first local executor build after a dependency upgrade can exceed the normal UI startup wait. Inspect the isolated session's Tauri and executor logs to distinguish ongoing compilation from a runtime failure.

## GitHub Release Auto Update

The repository includes `.github/workflows/wework-app.yml` for producing macOS DMGs, Windows installers, Tauri updater archives, signatures, and updater manifests on GitHub Actions. The updater endpoint embedded in the client points to the fixed `wework-updater` Release and uses Tauri `target` and `arch` placeholders to select the update channel and platform:

```text
https://github.com/<owner>/<repo>/releases/download/wework-updater/{{target}}-{{arch}}.json
```

The macOS CI job does not invoke `release-mac-app.sh`, but both release paths share `wework/scripts/generate-release-config.mjs`. The generator copies the complete `bundle.resources` list from `src-tauri/tauri.conf.json`, ensuring that Codex, hooks, bundled plugins, and hidden marketplace manifests are included in formal release packages. Update the base Tauri config when desktop resources change instead of duplicating the list in the workflow.

The workflow can only be started manually from GitHub Actions and does not respond to tag pushes. Select a release channel when starting it:

- `stable`: publishes a stable release. Leave `version` empty to increment the latest stable patch, or enter an `X.Y.Z` override.
- `beta`: publishes a Beta release. Do not enter a version; the workflow always derives the next `X.Y.Z-beta.N` from existing stable and Beta tags.
- `publish_release=false`: produces test artifacts only and does not commit version files or publish a Release.
- `publish_release=true`: synchronizes version files, builds signed artifacts, and publishes a GitHub Release.

For example, when the latest stable version is `1.2.3`, the first Beta is `1.2.4-beta.1`, followed by `1.2.4-beta.2` and `1.2.4-beta.3`. After publishing stable `1.2.4`, the next automatic Beta is `1.2.5-beta.1`.

A formal run creates or updates a `wework-v<version>` draft release. The Release changelog collects commits under `wework/` and `executor/` since the previous Wework tag. When no previous tag exists, the first release includes all matching history reachable from the release commit. Squash-merged PR entries include the PR number and `@contributor`; direct commits retain their short commit SHA and include `@contributor` when GitHub can identify the author's account. After the builds finish, the workflow generates that version's `latest.json`, uploads it to the same Release, and publishes the Release. Stable releases become GitHub latest. Beta releases are marked as prereleases and do not replace GitHub latest. Preventing tag-push triggers ensures that a tag created by the workflow cannot start another build of the same version and overwrite signed artifacts.

After publishing the versioned Release, the workflow updates rolling manifests in the fixed `wework-updater` Release:

- `stable-*` points only to the latest stable release.
- `beta-*` points to whichever Beta or stable release has the higher SemVer, so Beta users also receive newer stable releases.
- A release only replaces a rolling manifest when its SemVer is higher; historical or lower releases cannot downgrade users.

Users opt into Beta updates under Wework **Settings → About** by enabling **Receive Beta updates**. The client uses the `stable` target by default and the `beta` target after opt-in. Changing the setting immediately checks for updates and persists locally.

The updater manifest's `notes` field is persisted as the installed version's changelog during installation. On the first launch of the new version, Wework does not open the changelog automatically. Instead, it shows a fixed announcement at the bottom of the desktop sidebar above the account area. Clicking the announcement opens the Markdown release notes. Closing the details keeps the announcement available; only the announcement card's close button dismisses it, and that dismissal survives an app reload. The saved version must match the running app version, otherwise the client discards the stale record.

Configure these repository secrets in GitHub Actions:

- `TAURI_SIGNING_PRIVATE_KEY`: Tauri updater private key.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: private key password; leave empty if the key has no password.
- `TAURI_UPDATER_PUBKEY`: updater public key matching the private key. It is injected into the built app.

Do not rotate the updater private key unless it is acceptable for already-installed clients to stop receiving automatic updates. Tauri verifies new releases with the public key embedded in the installed client.

The workflow uploads these release assets:

- `WeWork_<version>_macos_arm64_unsigned-adhoc.dmg`
- `WeWork_<version>_macos_x64_unsigned-adhoc.dmg`
- `WeWork_<version>_macos_arm64.app.tar.gz`
- `WeWork_<version>_macos_arm64.app.tar.gz.sig`
- `WeWork_<version>_macos_x64.app.tar.gz`
- `WeWork_<version>_macos_x64.app.tar.gz.sig`
- `latest.json`

When downloaded from GitHub Release assets, the link points directly to the `.dmg` file and is not wrapped by an Actions artifact `.zip`. With the stable channel, leaving `version` empty increments the latest stable `wework-vX.Y.Z` tag. The Beta channel always derives its version automatically and ignores the `version` input.

For a formal release, the workflow syncs `wework/package.json`, `wework/src-tauri/tauri.conf.json`, `wework/src-tauri/Cargo.toml`, and `wework/src-tauri/Cargo.lock` to the release version before building, then commits those files directly back to the triggering `main` branch. The macOS build jobs and GitHub Release target use that version commit, keeping the About page version, Tauri bundle version, and source version aligned.

Manual workflow runs that do not publish a formal release only produce test artifacts and do not commit version files. An existing stable or Beta `wework-v<version>` tag can also be selected explicitly when manually starting the workflow. The workflow derives the version and channel from the tag, which points to an immutable commit, so it does not rewrite source files. If the tagged version files do not match the tag version, the release fails and the version files must be updated before creating the tag again. Pushing a tag alone does not start a release.

## CI DMG Without Apple Developer

The GitHub workflow applies an ad-hoc codesign signature to the `.app`, but it does not perform Apple notarization, so first launch still triggers Gatekeeper. Use this mode for internal testing and developer distribution only; do not label it as a notarized production package.

To force-open the app on first launch. On macOS 15 and later, the warning can still include a **Move to Trash** button; as long as CI passed `codesign --verify --deep --strict`, this is usually the normal Gatekeeper block for a non-notarized app, not a damaged package:

1. Open the DMG and drag `WeWork.app` to `/Applications`.
2. If the first launch shows an unidentified developer or **Move to Trash** warning, click Done. Do not click Move to Trash.
3. Open **System Settings > Privacy & Security**, then click **Open Anyway** in the Security section.

If macOS still keeps the quarantine flag, run this after confirming the source is trusted:

```bash
xattr -dr com.apple.quarantine /Applications/WeWork.app
```

## Production Release

Production release mode reads the remote `latest.json` and automatically increments the patch version. Use `--version` to override it:

```bash
cd wework
scripts/release-mac-app.sh --target prod --notes "Release notes."
```

The script uploads the `.app.tar.gz`, signature file, and DMG. The download entry should point to the latest universal DMG, while updater clients read `latest.json` to resolve the archive URL and signature for their platform.
