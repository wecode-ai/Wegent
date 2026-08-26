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
  })
})
