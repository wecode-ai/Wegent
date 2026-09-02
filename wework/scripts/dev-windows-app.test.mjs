import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'dev-windows-app.ps1')

describe('dev-windows-app', () => {
  test('serves the freshly built Wework app instead of the packaged core plugin bundle', async () => {
    const source = await readFile(scriptPath, 'utf8')

    expect(source).toContain("$env:WEWORK_APP_HOT_RELOAD = '1'")
    expect(source).toContain(
      "$env:WEWORK_APP_WEB_ROOT = Join-Path $WEWORK_DIR 'dsh\\app-wework\\web'"
    )
    expect(source).toContain('dev-wework-app-watch.mjs')
    expect(source).toContain('WEWORK_APP_WATCH_READY_FILE')
  })
})
