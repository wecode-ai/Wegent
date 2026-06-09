import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

interface TauriWindowConfig {
  titleBarStyle?: string
  hiddenTitle?: boolean
  decorations?: boolean
  trafficLightPosition?: {
    x: number
    y: number
  }
}

interface TauriConfig {
  app: {
    windows: TauriWindowConfig[]
  }
}

describe('macOS window chrome', () => {
  test('overlays the native title bar without displaying its title', () => {
    const configPath = resolve(process.cwd(), 'src-tauri/tauri.conf.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as TauriConfig
    const mainWindow = config.app.windows[0]

    expect(mainWindow.titleBarStyle).toBe('Overlay')
    expect(mainWindow.hiddenTitle).toBe(true)
    expect(mainWindow.decorations).toBe(true)
    expect(mainWindow.trafficLightPosition).toEqual({ x: 19, y: 29 })
  })

  test('grants permission to start native window dragging', () => {
    const capabilityPath = resolve(
      process.cwd(),
      'src-tauri/capabilities/default.json',
    )
    const capability = JSON.parse(readFileSync(capabilityPath, 'utf8')) as {
      permissions: string[]
    }

    expect(capability.permissions).toContain(
      'core:window:allow-start-dragging',
    )
  })
})
