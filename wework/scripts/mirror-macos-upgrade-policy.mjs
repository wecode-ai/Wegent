#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { publishedUpgradePolicies } from './lib/published-upgrade-policies.mjs'
import { mirrorMacosUpgradePolicy } from './lib/upgrade-evidence.mjs'

export async function mirrorMacosUpgradePolicies(
  { assets, channel, repository },
  execute = execFileSync
) {
  if (!assets || !['stable', 'beta'].includes(channel) || !repository)
    throw new Error('Expected assets, stable|beta, and repository')
  const release = JSON.parse(await readFile(join(assets, 'release-macos-x64.json'), 'utf8'))
  const previousPolicies = publishedUpgradePolicies(
    { repository, platform: 'macos', arch: 'x64' },
    execute
  )
  for (const targetChannel of channel === 'stable' ? ['stable', 'beta'] : ['beta']) {
    const arm = JSON.parse(
      await readFile(join(assets, `upgrade-policy-${targetChannel}-macos-arm64.json`), 'utf8')
    )
    const policy = mirrorMacosUpgradePolicy(
      arm,
      previousPolicies[targetChannel],
      {
        ...release,
        path: undefined,
        url: `https://github.com/${repository}/releases/download/wework-v${release.version}/${encodeURIComponent(release.name)}`,
      },
      Object.values(previousPolicies)
    )
    await writeFile(
      join(assets, `upgrade-policy-${targetChannel}-macos-x64.json`),
      JSON.stringify(policy, null, 2) + '\n'
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [assets, channel, repository] = process.argv.slice(2)
  await mirrorMacosUpgradePolicies({ assets, channel, repository })
}
