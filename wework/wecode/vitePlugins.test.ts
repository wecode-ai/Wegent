import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const viteConfigSource = readFileSync(resolve(import.meta.dirname, '../vite.config.ts'), 'utf8')

describe('Wecode Vite plugins', () => {
  test('keeps the public Vite config coupled only to the Wecode plugin entry', () => {
    expect(viteConfigSource).toContain('./wecode/vitePlugins.mjs')
    expect(viteConfigSource).not.toMatch(/vnc/i)
  })

  test('does not inject a second VNC viewer or asset pipeline', async () => {
    const { createWecodeVitePlugins } = await import('./vitePlugins.mjs')

    await expect(createWecodeVitePlugins()).resolves.toEqual([])
  })
})
