import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

interface TauriWindowConfig {
  decorations?: boolean
  shadow?: boolean
}

interface TauriConfig {
  app: {
    windows: TauriWindowConfig[]
  }
}

describe('Windows window chrome', () => {
  test('uses the native shadow to opt the borderless window into Windows 11 rounding', () => {
    const configPath = resolve(process.cwd(), 'src-tauri/tauri.windows.conf.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as TauriConfig
    const mainWindow = config.app.windows[0]

    expect(mainWindow.decorations).toBe(false)
    expect(mainWindow.shadow).toBe(true)
  })
})
