import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

interface TauriWindowConfig {
  titleBarStyle?: string
  hiddenTitle?: boolean
  decorations?: boolean
  dragDropEnabled?: boolean
  trafficLightPosition?: {
    x: number
    y: number
  }
}

interface TauriConfig {
  app: {
    windows: TauriWindowConfig[]
    security?: {
      assetProtocol?: {
        enable?: boolean
        scope?: {
          allow?: string[]
        }
      }
    }
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
    expect(mainWindow.trafficLightPosition).toEqual({ x: 19, y: 21 })
  })

  test('enables native file drop events in the desktop webview', () => {
    const configPath = resolve(process.cwd(), 'src-tauri/tauri.conf.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as TauriConfig
    const mainWindow = config.app.windows[0]

    expect(mainWindow.dragDropEnabled).toBe(true)
  })

  test('grants permission to start native window dragging', () => {
    const capabilityPath = resolve(process.cwd(), 'src-tauri/capabilities/default.json')
    const capability = JSON.parse(readFileSync(capabilityPath, 'utf8')) as {
      permissions: Array<string | object>
    }

    expect(capability.permissions).toContain('core:window:allow-start-dragging')
  })

  test('does not grant permission to reveal downloaded local images', () => {
    const capabilityPath = resolve(process.cwd(), 'src-tauri/capabilities/default.json')
    const capability = JSON.parse(readFileSync(capabilityPath, 'utf8')) as {
      permissions: Array<string | object>
    }

    expect(capability.permissions).not.toContain('opener:allow-reveal-item-in-dir')
  })

  test('enables asset protocol access for temporary Codex clipboard images', () => {
    const configPath = resolve(process.cwd(), 'src-tauri/tauri.conf.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as TauriConfig
    const assetProtocol = config.app.security?.assetProtocol

    expect(assetProtocol?.enable).toBe(true)
    expect(assetProtocol?.scope?.allow).toEqual(
      expect.arrayContaining(['$TEMP/**', '/var/folders/**', '/private/var/folders/**'])
    )
  })
})
