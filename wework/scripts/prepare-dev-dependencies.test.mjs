import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), 'prepare-dev-dependencies.mjs')

describe('prepare-dev-dependencies', () => {
  test('preserves the caller environment and fingerprints preparation logic', async () => {
    const source = await readFile(scriptPath, 'utf8')

    expect(source).not.toContain("CI: process.env.CI || '1'")
    expect(source.match(/join\(scriptDirectory, 'prepare-dev-dependencies\.mjs'\)/g)).toHaveLength(
      2
    )
  })
})
