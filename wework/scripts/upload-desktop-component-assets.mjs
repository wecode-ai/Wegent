#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { listComponentAssets } from './desktop-component-release.mjs'
import { hashComponentPath } from './lib/component-content-hash.mjs'

function runGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function verifyAsset(asset, name, size, digest) {
  if (asset.state !== 'uploaded' || asset.size !== size || asset.digest !== digest) {
    throw new Error(`Release asset ${name} is incomplete or differs from the local archive`)
  }
}

export async function uploadComponentAssets(directory, scope, tag, gh = runGh, log = console.log) {
  const names = await listComponentAssets(directory, scope)
  const release = JSON.parse(gh(['release', 'view', tag, '--json', 'apiUrl']))
  const readAssets = () =>
    JSON.parse(gh(['api', `${release.apiUrl}/assets?per_page=100`, '--paginate', '--slurp'])).flat()
  let assets = readAssets()
  for (const name of names) {
    const path = resolve(directory, name)
    const { size } = await stat(path)
    const digest = `sha256:${await hashComponentPath(path)}`
    const existing = assets.find(asset => asset.name === name)
    if (existing) {
      verifyAsset(existing, name, size, digest)
      log(`Reusing verified component asset ${name}`)
      continue
    }
    try {
      gh(['release', 'upload', tag, path])
      log(`Uploaded component asset ${name}`)
    } catch (error) {
      // An upload can succeed remotely even when gh receives an error and retries it.
      process.stderr.write(String(error.stderr ?? error.message) + '\n')
      assets = readAssets()
      const uploaded = assets.find(asset => asset.name === name)
      if (!uploaded) throw error
      verifyAsset(uploaded, name, size, digest)
      log(`Confirmed completed component upload after CLI error: ${name}`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, scope, tag] = process.argv.slice(2)
  if (!directory || !scope || !tag) {
    throw new Error(
      'Usage: upload-desktop-component-assets.mjs <assets-directory> <shared|version> <tag>'
    )
  }
  await uploadComponentAssets(directory, scope, tag)
}
