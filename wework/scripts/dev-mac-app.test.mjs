import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'dev-mac-app.sh')

describe('dev-mac-app', () => {
  test('isolates desktop state and uses Electron Node for child runtimes', async () => {
    const source = await readFile(scriptPath, 'utf8')

    expect(source).toContain('node "$SCRIPT_DIR/resolve-dev-user-data.mjs"')
    expect(source).toContain(
      'WEWORK_DEV_HARNESS_RUNTIME_ROOT:-$WEWORK_DIR/node_modules/.cache/harness-runtime-dev'
    )
    expect(source).toContain('WEWORK_DEV_EXECUTOR_PATH')
    expect(source).not.toContain(
      'WEWORK_HARNESS_RUNTIME_ROOT:-$WEWORK_DIR/node_modules/.cache/harness-runtime-dev'
    )
    expect(source).not.toContain('WEWORK_NODE_PATH=')
    expect(source).not.toContain('prepare:execution-runtime')
    expect(source).toContain('pnpm --dir electron prepare:package')
    expect(source).toContain(
      'export WEWORK_COMPONENT_RESOURCES_ROOT="$WEWORK_DIR/electron/resources"'
    )
    expect(source).not.toContain('pnpm run prepare:harness-runtime -- --materialize')

    const electronNodeReset = source.indexOf('unset ELECTRON_RUN_AS_NODE')
    const inheritedNodePathReset = source.indexOf('unset WEWORK_NODE_PATH')
    const inheritedNodeKindReset = source.indexOf('unset WEWORK_NODE_RUNTIME_KIND')
    const electronLaunch = source.indexOf('pnpm --dir electron dev')
    expect(electronNodeReset).toBeGreaterThan(-1)
    expect(inheritedNodePathReset).toBeGreaterThan(electronNodeReset)
    expect(inheritedNodeKindReset).toBeGreaterThan(inheritedNodePathReset)
    expect(inheritedNodeKindReset).toBeLessThan(electronLaunch)
  })
})
