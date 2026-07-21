import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))

export async function createWecodeVitePlugins() {
  const pluginPath = path.resolve(moduleDirectory, './features/vnc/viteAssets.mjs')
  const pluginUrl = pathToFileURL(pluginPath)
  pluginUrl.searchParams.set('version', String(fs.statSync(pluginPath).mtimeMs))
  const { createVncAssetsPlugin } = await import(pluginUrl.href)

  return [createVncAssetsPlugin()]
}
