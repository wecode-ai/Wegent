#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const weworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = process.argv[2]?.trim()

if (!version) {
  throw new Error('Usage: sync-desktop-release-version.mjs <version>')
}

for (const path of [
  resolve(weworkRoot, 'package.json'),
  resolve(weworkRoot, 'electron/package.json'),
]) {
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.version = version
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
}
