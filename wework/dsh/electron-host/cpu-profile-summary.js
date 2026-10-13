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
const additionalPackages = [
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/cordis-plugin-group',
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-http-proxy',
  '@deepseek-ai/dsh-cmdline',
  '@deepseek-ai/dsh-home-paths',
  '@deepseek-ai/dsh-launch-environment',
  '@deepseek-ai/dsh-atomic-write',
  'quansync',
  'resolve.exports',
  'commander',
]
const hostPlugins = [
  ['@wegent/dsh-app-wework', 'wework-app'],
  ['@wegent/dsh-electron-host', 'wework-electron-host'],
  ['@wegent/dsh-browser-runtime', 'wework-browser-runtime'],
  ['@wegent/dsh-secure-storage', 'wework-secure-storage'],
  ['@wegent/dsh-executor-runtime', 'wework-executor-runtime'],
  ['@wegent/dsh-terminal-runtime', 'wework-terminal-runtime'],
  ['@wegent/dsh-transcript-sync', 'wework-transcript-sync'],
  ['@wegent/dsh-plugin-runtime', 'wework-plugin-runtime'],
]
const nodeGroups = [
  [/^node:(?:fs(?:\/|$)|internal\/fs(?:\/|$))/, 'node-fs'],
  [/^node:(?:stream(?:\/|$)|internal\/streams(?:\/|$))/, 'node-streams'],
  [/^node:(?:async_hooks$|internal\/async_hooks$)/, 'node-async-hooks'],
  [/^node:(?:events$|internal\/events(?:\/|$))/, 'node-events'],
  [/^node:(?:buffer$|internal\/buffer$)/, 'node-buffer'],
  [/^node:(?:util(?:\/|$)|internal\/util(?:\/|$))/, 'node-util'],
  [/^node:(?:url$|internal\/url$)/, 'node-url'],
  [/^node:(?:vm$|internal\/vm$)/, 'node-vm'],
  [/^node:(?:sqlite$|internal\/sqlite(?:\/|$))/, 'node-sqlite'],
  [/^node:(?:net$|http$|https$|internal\/http(?:\/|$))/, 'node-network'],
  [/^node:internal\/bootstrap(?:\/|$)/, 'node-bootstrap'],
  [/^node:internal\/process(?:\/|$)/, 'node-process'],
  [/^node:internal\/modules\/package_json_reader$/, 'node-package-json'],
]
const loaderGroups = new Set([
  'node-esm-loader',
  'node-cjs-loader',
  '@deepseek-ai/cordis-plugin-loader',
])
const hostPluginGroups = hostPlugins.map(([name, directory]) => [
  name,
  new RegExp(`/(?:wework-core-plugins|core-plugins)(?:/[^/]+)?/${directory}/`),
])

function detailedModuleGroup(frame) {
  const group = moduleGroup(frame)
  if (group !== 'other' && group !== 'node-other') return group
  const url = typeof frame.url === 'string' ? frame.url.replaceAll('\\', '/') : ''
  for (const name of additionalPackages) {
    if (url.includes(`/node_modules/${name}/`)) return name
  }
  for (const [name, pattern] of hostPluginGroups) {
    if (url.includes(`/node_modules/${name}/`) || pattern.test(url)) return name
  }
  for (const [pattern, name] of nodeGroups) {
    if (pattern.test(url)) return name
  }
  return group
}

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

function recordAncestors(node, nodes, parents, delta, operations, loaderAncestors) {
  const visited = new Set()
  let bootRecorded = false
  let loaderRecorded = false
  while (node && !visited.has(node.id)) {
    visited.add(node.id)
    const frame = node.callFrame ?? {}
    const group = moduleGroup(frame)
    if (!loaderRecorded && loaderGroups.has(group)) {
      addSample(loaderAncestors, group, delta)
      loaderRecorded = true
    }
    if (
      !bootRecorded &&
      bootOperations.has(frame.functionName) &&
      ['@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot'].includes(group)
    ) {
      addSample(operations, frame.functionName, delta)
      bootRecorded = true
    }
    if (loaderRecorded && bootRecorded) break
    node = nodes.get(parents.get(node.id))
  }
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
  const moduleDetails = new Map()
  const loaderAncestors = new Map()
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
    addSample(moduleDetails, detailedModuleGroup(node.callFrame), capturedDelta)
    recordAncestors(node, nodes, parents, capturedDelta, operations, loaderAncestors)
  }
  return {
    scope: startupEndTimeUs === undefined ? 'captured-process-lifecycle' : 'startup-to-endpoint',
    durationMs: ((startupEndTimeUs ?? profile.endTime) - profile.startTime) / 1000,
    samples: capturedSamples,
    modules: rows(modules),
    bootOperations: rows(operations),
    moduleDetails: rows(moduleDetails),
    nearestLoaderAncestors: rows(loaderAncestors),
  }
}
