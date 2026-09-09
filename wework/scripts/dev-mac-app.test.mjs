import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'dev-mac-app.sh')

describe('dev-mac-app', () => {
  test('isolates desktop state and uses Electron Node for child runtimes', async () => {
    const source = await readFile(scriptPath, 'utf8')

    expect(source).toContain('node "$SCRIPT_DIR/resolve-dev-user-data.mjs"')
    expect(source).toContain('node "$SCRIPT_DIR/resolve-dev-instance-identity.mjs"')
    expect(source).toContain(
      'WEWORK_DEV_APP_IDENTIFIER:-io.wecode.wework.dev.$WEWORK_DEV_INSTANCE_ID'
    )
    expect(source).toContain(
      'node "$SCRIPT_DIR/resolve-dev-user-data.mjs" "$PROJECT_DIR" "${WEWORK_DEV_USER_DATA_DIR:-}"'
    )
    expect(source).not.toContain(
      'node "$SCRIPT_DIR/resolve-dev-user-data.mjs" "$PROJECT_DIR" "${WEWORK_USER_DATA_DIR:-}"'
    )
    expect(source).toContain('if ! WEWORK_USER_DATA_DIR="$(')
    expect(source).toContain('if [ -z "$WEWORK_USER_DATA_DIR" ]; then')
    expect(source).toContain('export WEWORK_USER_DATA_DIR')
    expect(source).toContain('unset WEWORK_DEV_APP_IDENTIFIER')
    expect(source).toContain('unset WEWORK_DEV_USER_DATA_DIR')
    expect(source).toContain('export WEWORK_DEV_INSTANCE_ID="${DEV_IDENTITY_FIELDS[2]}"')
    expect(source).toContain('export WEWORK_DEV_INSTANCE_LABEL="${DEV_IDENTITY_FIELDS[3]}"')
    expect(source).toContain('export WEWORK_DEV_DOCK_TITLE="${DEV_IDENTITY_FIELDS[4]}"')
    expect(source).toContain('export WEWORK_DEV_EXECUTABLE_NAME="${DEV_IDENTITY_FIELDS[5]}"')
    expect(source).toContain('cp -cR "$source_app" "$temporary_app"')
    expect(source).toContain('plutil -replace CFBundleDisplayName')
    expect(source).toContain('plutil -replace CFBundleExecutable')
    expect(source).toContain('mv "$source_executable" "$target_executable"')
    expect(source).toContain('target_app="$bundle_root/$WEWORK_DEV_EXECUTABLE_NAME.app"')
    expect(source).toContain('codesign --force --deep --sign - "$temporary_app"')
    expect(source).toContain(
      'DEV_ELECTRON_APP="$(prepare_dev_electron_app "$SOURCE_ELECTRON_APP")"'
    )
    expect(source).toContain('WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT')
    expect(source).toContain('$WEWORK_DIR/node_modules/.cache/harness-runtime-dev')
    expect(source).toContain('WEWORK_DEV_EXECUTOR_PATH')
    expect(source).toContain('WEGENT_EXECUTOR_DEV_BUILD_ID="$WEWORK_DEV_INSTANCE_ID"')
    expect(source).toContain('$WEWORK_DIR/node_modules/.cache/wework-executor-dev/wegent-executor')
    expect(source).toContain('cp "$MANAGED_SOURCE_EXECUTOR_BINARY" "$EXECUTOR_BINARY_TEMP"')
    expect(source).toContain('mv -f "$EXECUTOR_BINARY_TEMP" "$WEGENT_EXECUTOR_BINARY"')
    expect(source).toContain('node "$SCRIPT_DIR/prepare-dev-dependencies.mjs"')
    expect(source).toContain('node "$SCRIPT_DIR/prepare-dev-component-resources.mjs"')
    expect(source).toContain('WEWORK_CORE_PLUGIN_ROOT=')
    expect(source).toContain('if ! WEWORK_CORE_PLUGINS_SHA256="$(')
    expect(source).toContain('export WEWORK_CORE_PLUGINS_SHA256')
    expect(source).not.toContain('export WEWORK_CORE_PLUGINS_SHA256="$(')
    expect(source).not.toContain('WEWORK_NODE_PATH=')
    expect(source).not.toContain('prepare:execution-runtime')
    expect(source).not.toContain('pnpm --dir electron prepare:package')
    expect(source).toContain(
      'WEWORK_DEV_COMPONENT_RESOURCES:-$WEWORK_DIR/node_modules/.cache/wework-electron-dev-resources'
    )
    expect(source).toContain('node "$SCRIPT_DIR/prepare-harness-runtime.mjs" --materialize')

    const electronNodeReset = source.indexOf('unset ELECTRON_RUN_AS_NODE')
    const inheritedNodePathReset = source.indexOf('unset WEWORK_NODE_PATH')
    const inheritedNodeKindReset = source.indexOf('unset WEWORK_NODE_RUNTIME_KIND')
    const executorBuild = source.indexOf(
      'cargo build --manifest-path "$PROJECT_DIR/executor/Cargo.toml"'
    )
    const executorCopy = source.indexOf(
      'cp "$MANAGED_SOURCE_EXECUTOR_BINARY" "$EXECUTOR_BINARY_TEMP"'
    )
    const electronBuild = source.indexOf('pnpm --dir electron run build')
    const electronLaunch = source.indexOf('"$ELECTRON_BINARY" "$WEWORK_DIR/electron"')
    expect(electronNodeReset).toBeGreaterThan(-1)
    expect(inheritedNodePathReset).toBeGreaterThan(electronNodeReset)
    expect(inheritedNodeKindReset).toBeGreaterThan(inheritedNodePathReset)
    expect(inheritedNodeKindReset).toBeLessThan(electronBuild)
    expect(executorBuild).toBeGreaterThan(-1)
    expect(executorCopy).toBeGreaterThan(executorBuild)
    expect(executorCopy).toBeLessThan(electronLaunch)
    expect(electronBuild).toBeLessThan(electronLaunch)
  })
})
