import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packages = [
  '@deepseek-ai/dsh',
  '@deepseek-ai/dsh-app-boot',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-host-frontend-static',
  '@deepseek-ai/schemastery',
  'node-pty',
  'semver',
  'js-yaml',
]
const nativeOperations = new Set([
  'readFileUtf8',
  'readPackageJSON',
  'internalModuleStat',
  'getPackageScopeConfig',
  'compileSourceTextModule',
  'compileForInternalLoader',
  'wrapSafe',
  'realpath',
  'existsSync',
  'open',
  'lstat',
])
const bootOperations = new Set([
  'runProfile',
  'createRuntimeResolution',
  'collectInstallationScopePackages',
  'dependencyClosure',
  'boot',
  'mountRootInclude',
  'auditStartupEntries',
])

function moduleGroup(frame) {
  if (frame.functionName === '(idle)') return 'idle'
  if (frame.functionName === '(garbage collector)') return 'garbage-collector'
  const url = typeof frame.url === 'string' ? frame.url.replaceAll('\\', '/') : ''
  for (const name of packages) {
    if (url.includes(`/node_modules/${name}/`)) return name
  }
  if (url.startsWith('node:internal/modules/esm/')) return 'node-esm-loader'
  if (url.startsWith('node:internal/modules/cjs/')) return 'node-cjs-loader'
  if (url.startsWith('node:')) return 'node-other'
  if (!url && nativeOperations.has(frame.functionName)) return `native:${frame.functionName}`
  return 'other'
}

function addSample(groups, name, microseconds) {
  const record = groups.get(name) ?? { name, samples: 0, sampledMs: 0 }
  record.samples += 1
  record.sampledMs += microseconds / 1000
  groups.set(name, record)
}

function rows(groups) {
  return [...groups.values()]
    .map(row => ({ ...row, sampledMs: Math.round(row.sampledMs * 1000) / 1000 }))
    .sort((left, right) => right.sampledMs - left.sampledMs)
}

export function summarizeCoreCpuProfile(profile, startupEndTimeUs) {
  if (
    !Array.isArray(profile?.nodes) ||
    !Array.isArray(profile.samples) ||
    !Array.isArray(profile.timeDeltas) ||
    profile.samples.length !== profile.timeDeltas.length ||
    !Number.isFinite(profile.startTime) ||
    !Number.isFinite(profile.endTime) ||
    profile.endTime < profile.startTime
  ) {
    throw new Error('Invalid CPU profile')
  }
  if (
    startupEndTimeUs !== undefined &&
    (!Number.isFinite(startupEndTimeUs) ||
      startupEndTimeUs <= profile.startTime ||
      startupEndTimeUs > profile.endTime)
  ) {
    throw new Error('Startup marker is outside CPU profile')
  }
  const nodes = new Map(profile.nodes.map(node => [node.id, node]))
  const parents = new Map()
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parents.set(child, node.id)
  }
  const modules = new Map()
  const operations = new Map()
  let sampleTime = profile.startTime
  let capturedSamples = 0
  for (const [index, id] of profile.samples.entries()) {
    const delta = profile.timeDeltas[index]
    const node = nodes.get(id)
    if (!node?.callFrame || !Number.isFinite(delta) || delta < 0) {
      throw new Error('Invalid CPU profile')
    }
    const capturedDelta = Math.max(
      0,
      Math.min(sampleTime + delta, startupEndTimeUs ?? profile.endTime) - sampleTime
    )
    sampleTime += delta
    if (capturedDelta === 0) continue
    capturedSamples += 1
    addSample(modules, moduleGroup(node.callFrame), capturedDelta)
    let current = node
    const visited = new Set()
    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      const frame = current.callFrame
      if (
        bootOperations.has(frame?.functionName) &&
        ['@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot'].includes(moduleGroup(frame))
      ) {
        addSample(operations, frame.functionName, capturedDelta)
        break
      }
      current = nodes.get(parents.get(current.id))
    }
  }
  return {
    scope: startupEndTimeUs === undefined ? 'captured-process-lifecycle' : 'startup-to-endpoint',
    durationMs: ((startupEndTimeUs ?? profile.endTime) - profile.startTime) / 1000,
    samples: capturedSamples,
    modules: rows(modules),
    bootOperations: rows(operations),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const profile = JSON.parse(await readFile(process.argv[2], 'utf8'))
    const startupEndTimeUs = process.argv[3] === undefined ? undefined : Number(process.argv[3])
    console.log(JSON.stringify(summarizeCoreCpuProfile(profile, startupEndTimeUs), null, 2))
  } catch {
    console.error('Could not summarize CPU profile')
    process.exitCode = 1
  }
}
