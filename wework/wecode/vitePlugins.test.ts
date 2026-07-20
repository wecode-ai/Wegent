import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'

const viteConfigSource = readFileSync(resolve(import.meta.dirname, '../vite.config.ts'), 'utf8')

describe('Wecode Vite plugins', () => {
  test('keeps the public Vite config coupled only to the Wecode plugin entry', () => {
    expect(viteConfigSource).toContain('./wecode/vitePlugins.mjs')
    expect(viteConfigSource).not.toMatch(/vnc/i)
  })

  test('loads the VNC asset plugin through a versioned native module', async () => {
    const modulePath = resolve(import.meta.dirname, 'vitePlugins.mjs')
    expect(existsSync(modulePath)).toBe(true)
    if (!existsSync(modulePath)) return

    const moduleSource = readFileSync(modulePath, 'utf8')
    const moduleUrl = pathToFileURL(modulePath).href
    const { createWecodeVitePlugins } = (await import(/* @vite-ignore */ moduleUrl)) as {
      createWecodeVitePlugins: () => Promise<Array<{ name: string }>>
    }

    expect(moduleSource).toContain('./features/vnc/viteAssets.mjs')
    expect(moduleSource).toMatch(/searchParams\.set\(\s*'version'/)
    expect(moduleSource).toMatch(/statSync\([^)]+\)\.mtimeMs/)
    await expect(createWecodeVitePlugins()).resolves.toEqual([
      expect.objectContaining({ name: 'wework-vnc-assets' }),
    ])
  })
})
