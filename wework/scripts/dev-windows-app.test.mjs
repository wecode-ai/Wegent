import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'dev-windows-app.ps1')

describe('dev-windows-app', () => {
  test('mirrors the macOS development instance and component startup behavior', async () => {
    const source = await readFile(scriptPath, 'utf8')

    expect(source).toContain('resolve-dev-instance-identity.mjs')
    expect(source).toContain('"io.wecode.wework.dev.$env:WEWORK_DEV_INSTANCE_ID"')
    expect(source).toContain('resolve-dev-user-data.mjs')
    expect(source).toContain('Get-DevIdentityFields')
    expect(source).toContain('Remove-Item Env:WEWORK_DEV_APP_IDENTIFIER')
    expect(source).toContain('Remove-Item Env:WEWORK_DEV_USER_DATA_DIR')
    expect(source).toContain('node_modules\\.cache\\wework-executor-dev\\wegent-executor.exe')
    expect(source).toContain('$env:WEGENT_EXECUTOR_DEV_BUILD_ID = $env:WEWORK_DEV_INSTANCE_ID')
    expect(source).toContain('node_modules\\.cache\\harness-runtime-dev')
    expect(source).toContain('node_modules\\.cache\\wework-electron-dev-resources')
    expect(source).toContain('prepare-dev-component-resources.mjs')
    expect(source).toContain('WEWORK_CORE_PLUGINS_SHA256')
    expect(source).toContain('pnpm --dir electron run build')
    expect(source).toContain('electron\\node_modules\\electron\\dist\\electron.exe')
  })

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
