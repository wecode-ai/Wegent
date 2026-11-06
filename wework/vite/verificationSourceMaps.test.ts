// @vitest-environment node
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { expect, test } from 'vitest'
import { verificationSourceMaps } from './verificationSourceMaps'

test('a real Vite build maps nested emitted chunks to readable original files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verification-maps-'))
  const source = join(directory, 'input.js')
  await writeFile(
    source,
    'export async function hotspot() { return (await import("./lazy.js")).hotspot() }'
  )
  await writeFile(
    join(directory, 'lazy.js'),
    'import "./lazy.css"; export function hotspot() { return 42 }'
  )
  await writeFile(join(directory, 'lazy.css'), '.hotspot { color: red }')
  try {
    const output = await build({
      configFile: false,
      root: directory,
      logLevel: 'silent',
      plugins: [verificationSourceMaps()],
      build: {
        outDir: join(directory, 'dist'),
        sourcemap: true,
        rolldownOptions: {
          input: source,
          preserveEntrySignatures: 'strict',
          output: {
            entryFileNames: 'assets/nested/[name].js',
            chunkFileNames: 'assets/nested/[name].js',
          },
        },
      },
    })
    if (Array.isArray(output) || !('output' in output))
      throw new Error('Expected a single build output')
    const assets = output.output.filter(
      item => item.type === 'asset' && item.fileName.endsWith('.map')
    )
    expect(assets.length).toBeGreaterThanOrEqual(2)
    const sources = []
    for (const asset of assets) {
      const map = JSON.parse(await readFile(join(directory, 'dist', asset.fileName), 'utf8'))
      for (const url of map.sources) {
        sources.push(await realpath(fileURLToPath(url)))
        expect(await readFile(fileURLToPath(url), 'utf8')).toContain('hotspot')
      }
    }
    expect(sources).toContain(await realpath(source))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
