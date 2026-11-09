import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  aggregateUpgradeShards,
  validateUpgradeShardPlan,
} from './lib/upgrade-verification-shards.mjs'

const [planDirectory, shardDirectory, outputDirectory] = process.argv.slice(2)
if (!planDirectory || !shardDirectory || !outputDirectory)
  throw new Error('Expected frozen plans, shard reports, and output directory')
const policy = JSON.parse(
  await readFile(new URL('../upgrade-policy.json', import.meta.url), 'utf8')
)
const approvedExclusions = (process.env.WEWORK_APPROVED_BASELINE_EXCLUSIONS || '')
  .split(',')
  .map(source => source.trim())
  .filter(Boolean)
const files = await readdir(resolve(shardDirectory))
const shards = await Promise.all(
  files
    .filter(name => /^upgrade-shard-.*\.json$/.test(name))
    .map(async name => JSON.parse(await readFile(join(shardDirectory, name), 'utf8')))
)
const plans = await Promise.all(
  (await readdir(planDirectory)).map(async name =>
    JSON.parse(await readFile(join(planDirectory, name), 'utf8'))
  )
)
if (plans.length !== 2 || new Set(plans.map(plan => plan.platform)).size !== 2)
  throw new Error('Both independent package platforms require frozen upgrade plans')
await mkdir(outputDirectory, { recursive: true })
let consumed = 0
for (const frozen of plans) {
  validateUpgradeShardPlan(frozen, {
    version: process.env.WEWORK_UPGRADE_VERSION,
    channel: process.env.WEWORK_UPGRADE_CHANNEL,
    policy,
    platform: frozen.platform,
    arch: frozen.arch,
  })
  if (
    !(
      (frozen.platform === 'macos' && frozen.arch === 'arm64') ||
      (frozen.platform === 'windows' && frozen.arch === 'x64')
    )
  )
    throw new Error('Invalid upgrade platform')
  const selected = shards.filter(
    shard => shard.target.platform === frozen.platform && shard.target.arch === frozen.arch
  )
  consumed += selected.length
  const catalogs = await aggregateUpgradeShards(
    frozen,
    selected,
    process.env.GITHUB_RUN_ID,
    approvedExclusions
  )
  for (const shard of selected.filter(shard => shard.status === 'failed')) {
    const exclusion = `${frozen.platform}/${frozen.arch}/${shard.channel}/${shard.source.version}`
    const message = `Excluded incompatible baseline ${exclusion} -> ${frozen.version}; explicitly approved, no upgrade edge generated.`
    console.warn(`::warning::${message}`)
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `- ${message}\n`)
  }
  for (const catalog of catalogs)
    await writeFile(
      join(
        outputDirectory,
        `upgrade-policy-${catalog.channel}-${catalog.platform}-${catalog.arch}.json`
      ),
      JSON.stringify(catalog, null, 2) + '\n'
    )
}
if (consumed !== shards.length) throw new Error('Unexpected upgrade source shard')
