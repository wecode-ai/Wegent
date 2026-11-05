import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL, URL } from 'node:url'

import { UPGRADE_CHECKPOINTS, UPGRADE_CHECKPOINT_GROUP } from './upgrade-suite.mjs'

const CATALOG_DIRECTORY = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), 'catalog') + sep
)
const CI_SHARD_COUNTS = { core: 10, cloud: 8 }
const CI_ARRAY_NAMES = {
  core: 'core_segments',
  cloud: 'cloud_segments',
  plugins: 'plugin_segments',
  release: 'formal_release_segments',
  cloudWorktree: 'cloud_worktree_segments',
}
const FIELDS = new Set([
  'id',
  'order',
  'pluginOrder',
  'groupOrder',
  'members',
  'ciHost',
  'scenario',
  'scenarioOnly',
  'cloudOnly',
  'resources',
  'ci',
  'paths',
])

/** Discover independent declarations without importing scenario code or services. */
export function readDesktopCheckpointDefinitions(directory = CATALOG_DIRECTORY) {
  return readdirSync(directory)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => {
      const value = JSON.parse(readFileSync(new URL(name, directory), 'utf8'))
      if (Object.hasOwn(value, 'id'))
        throw new Error(`Checkpoint id comes from its filename: ${name}`)
      return { id: name.slice(0, -5), ...value }
    })
}

// The release suite remains the owner of package-pair checkpoints and their group.
function releaseDefinitions() {
  return [
    ...UPGRADE_CHECKPOINTS.map((id, index) => ({
      id,
      order: 161000 + index,
      scenario: './scenarios/retained-upgrade-baseline.scenario.mjs',
      scenarioOnly: true,
    })),
    { id: UPGRADE_CHECKPOINT_GROUP, groupOrder: 1000, members: UPGRADE_CHECKPOINTS },
  ]
}

function ordered(entries, field) {
  return entries
    .filter(entry => entry[field] !== undefined)
    .sort((left, right) => left[field] - right[field] || left.id.localeCompare(right.id, 'en'))
}

function validateDefinitions(entries) {
  const ids = new Set()
  for (const entry of entries) {
    if (!/^[a-z][a-z0-9-]*$/.test(entry.id) || ids.has(entry.id))
      throw new Error(`Invalid or duplicate desktop checkpoint: ${entry.id}`)
    ids.add(entry.id)
    for (const field of Object.keys(entry)) {
      if (!FIELDS.has(field)) throw new Error(`Unknown checkpoint field: ${entry.id}.${field}`)
    }
    for (const field of ['order', 'pluginOrder', 'groupOrder']) {
      if (entry[field] !== undefined && !Number.isFinite(entry[field]))
        throw new Error(`Invalid checkpoint order: ${entry.id}.${field}`)
    }
    for (const field of ['scenarioOnly', 'cloudOnly']) {
      if (entry[field] !== undefined && typeof entry[field] !== 'boolean')
        throw new Error(`Invalid checkpoint flag: ${entry.id}.${field}`)
    }
    for (const field of ['members', 'resources', 'paths']) {
      if (
        entry[field] !== undefined &&
        (!Array.isArray(entry[field]) ||
          entry[field].some(value => typeof value !== 'string' || /[\t\r\n]/.test(value)))
      )
        throw new Error(`Invalid checkpoint list: ${entry.id}.${field}`)
    }
    if (
      entry.scenario !== undefined &&
      !/^\.\/scenarios\/[a-z0-9-]+\.scenario\.mjs$/.test(entry.scenario)
    )
      throw new Error(`Invalid checkpoint scenario: ${entry.id}`)
    if (entry.scenarioOnly && !entry.scenario)
      throw new Error(`Scenario-only checkpoint has no module: ${entry.id}`)
    if (entry.groupOrder !== undefined && !entry.members?.length)
      throw new Error(`Checkpoint group has no members: ${entry.id}`)
    for (const [lane, assignment] of Object.entries(entry.ci ?? {})) {
      if (!Object.hasOwn(CI_ARRAY_NAMES, lane))
        throw new Error(`Unknown CI lane: ${entry.id}.${lane}`)
      if (!Number.isFinite(assignment.order))
        throw new Error(`Invalid CI order: ${entry.id}.${lane}`)
    }
  }
  for (const entry of entries) {
    for (const member of [...(entry.members ?? []), ...(entry.ciHost ? [entry.ciHost] : [])]) {
      if (!ids.has(member))
        throw new Error(`Unknown checkpoint reference: ${entry.id} -> ${member}`)
    }
  }
}

/** Build the runner and CI views from the same authored declarations. */
export function buildDesktopCheckpointCatalog(entries) {
  validateDefinitions(entries)
  const by = field => ordered(entries, field).map(entry => entry.id)
  const pairs = field =>
    entries.filter(entry => entry[field] !== undefined).map(entry => [entry.id, entry[field]])
  const ci = Object.fromEntries(
    Object.entries(CI_ARRAY_NAMES).map(([lane, key]) => [
      key,
      ordered(
        entries
          .filter(entry => entry.ci?.[lane])
          .map(entry => ({
            id: entry.id,
            order: entry.ci[lane].order,
          })),
        'order'
      ).map(entry => entry.id),
    ])
  )
  for (const [lane, count] of Object.entries(CI_SHARD_COUNTS)) {
    ci[`${lane}_shards`] = buildShards(entries, lane, count)
  }
  return {
    DESKTOP_CHECKPOINTS: by('order'),
    PLUGIN_SEGMENTS: by('pluginOrder'),
    DESKTOP_CHECKPOINT_GROUPS: new Map(
      ordered(entries, 'groupOrder').map(entry => [entry.id, entry.members])
    ),
    DESKTOP_CHECKPOINT_CI_HOSTS: new Map(pairs('ciHost')),
    CHECKPOINT_RESOURCES: new Map(pairs('resources')),
    CHECKPOINT_SCENARIO_MODULES: Object.fromEntries(pairs('scenario')),
    SCENARIO_ONLY_CHECKPOINTS: new Set(
      entries.filter(entry => entry.scenarioOnly).map(entry => entry.id)
    ),
    CLOUD_ONLY_CHECKPOINTS: new Set(
      entries.filter(entry => entry.cloudOnly).map(entry => entry.id)
    ),
    ...buildPathTargets(entries),
    ci,
  }
}

function buildShards(entries, lane, count) {
  const shards = Array.from({ length: count }, () => [])
  for (const entry of entries) {
    const assignment = entry.ci?.[lane]
    if (!assignment) continue
    if (!Number.isInteger(assignment.shard) || assignment.shard < 1 || assignment.shard > count)
      throw new Error(
        `${lane === 'core' ? 'Core' : 'Cloud'} segment missing from ${lane}_shards: ${entry.id}`
      )
    if (!Number.isFinite(assignment.order) || !Number.isFinite(assignment.position))
      throw new Error(`Invalid CI order: ${entry.id}.${lane}`)
    shards[assignment.shard - 1].push({ id: entry.id, order: assignment.position })
  }
  return shards.map((entries, index) => {
    if (!entries.length) throw new Error(`Empty desktop CI shard: ${lane}-${index + 1}`)
    return ordered(entries, 'order')
      .map(entry => entry.id)
      .join(',')
  })
}

function buildPathTargets(entries) {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const targetsFor = (id, visited = new Set()) => {
    if (visited.has(id)) return []
    visited.add(id)
    const entry = byId.get(id)
    if (entry.ciHost) return targetsFor(entry.ciHost, visited)
    const targets = ['core', 'cloud', 'plugins']
      .filter(lane => entry.ci?.[lane])
      .map(lane => `${lane}:${id}`)
    if (targets.length) return targets
    const owners =
      entry.members ??
      entries.filter(parent => parent.members?.includes(id)).map(parent => parent.id)
    return owners.flatMap(owner => targetsFor(owner, visited))
  }
  const paths = new Map()
  const additionalPaths = new Map()
  for (const entry of entries) {
    const targets = targetsFor(entry.id)
    const patterns = [
      `wework/e2e/desktop/catalog/${entry.id}.json`,
      ...(entry.scenario ? [`wework/e2e/desktop/${entry.scenario.slice(2)}`] : []),
      ...(entry.paths ?? []),
    ]
    for (const pattern of patterns)
      paths.set(pattern, [...new Set([...(paths.get(pattern) ?? []), ...targets])])
    for (const pattern of entry.paths ?? [])
      additionalPaths.set(pattern, [
        ...new Set([...(additionalPaths.get(pattern) ?? []), ...targets]),
      ])
  }
  return { PATH_TARGETS: paths, ADDITIONAL_PATH_TARGETS: additionalPaths }
}

export function loadDesktopCheckpointCatalog() {
  return buildDesktopCheckpointCatalog([
    ...readDesktopCheckpointDefinitions(),
    ...releaseDefinitions(),
  ])
}

// Tab-separated records are data, never shell source. Bash consumers use read.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = loadDesktopCheckpointCatalog()
  for (const [name, values] of Object.entries(catalog.ci)) {
    for (const value of values) console.log(`${name}\t${value}`)
  }
  for (const [pattern, targets] of catalog.PATH_TARGETS) {
    for (const target of targets) console.log(`path_target\t${target}\t${pattern}`)
  }
  for (const [pattern, targets] of catalog.ADDITIONAL_PATH_TARGETS) {
    for (const target of targets) console.log(`additional_path_target\t${target}\t${pattern}`)
  }
}
