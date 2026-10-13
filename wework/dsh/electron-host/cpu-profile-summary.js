const validationCodes = new Set([
  'core_profile_invalid_shape',
  'core_profile_invalid_marker',
  'core_profile_missing_sample_node',
  'core_profile_missing_sample_frame',
  'core_profile_nonfinite_delta',
  'core_profile_negative_delta',
  'core_profile_sample_outside_clock',
])

export function coreCpuProfileValidationCode(value) {
  return validationCodes.has(value) ? value : undefined
}

function invalidProfile(code, message = 'Invalid CPU profile') {
  return Object.assign(new Error(message), { code })
}

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
const nativeLoaderOperations = new Set([
  'materializedNativeBinaryPath',
  'cachedFileMatches',
  'packageVersionForNativeBinary',
  'sha256',
  'loadPrebuild',
  'loadEntry',
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
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-sdk-minimal',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-package-manifest',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-timer',
  '@eslint-community/regexpp',
  'ajv',
  'fast-uri',
  'fast-deep-equal',
  'json-schema-traverse',
  'require-from-string',
  'node-addon-require-builtin',
  'node-addon-native-custom-loader',
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
  ['@wegent/dsh-conversation-export', 'wework-conversation-export'],
  ['@wegent/dsh-wework-plugin-developer', 'wework-plugin-developer'],
  ['@wegent/dsh-ui-core-apps', 'wework-ui-core-apps'],
  ['@wegent/dsh-ui-core-settings', 'wework-ui-core-settings'],
  ['@wegent/dsh-ui-plugin-center', 'wework-ui-plugin-center'],
  ['@wegent/dsh-ui-applications', 'wework-ui-applications'],
  ['@wegent/dsh-ui-automations', 'wework-ui-automations'],
  ['@wegent/dsh-ui-cloud-work', 'wework-ui-cloud-work'],
  ['@wegent/dsh-ui-home-focus', 'wework-ui-home-focus'],
  ['@wegent/dsh-ui-home-developer', 'wework-ui-home-developer'],
  ['@wegent/dsh-ui-git', 'wework-ui-git'],
  ['@wegent/dsh-ui-outputs', 'wework-ui-outputs'],
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

const publicPackageGroups = new Set([
  ...packages,
  ...additionalPackages,
  ...hostPlugins.map(([name]) => name),
])

function detailedModuleGroup(frame, group = moduleGroup(frame)) {
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
  if (group === 'other') {
    if (!url) return 'unattributed-empty-url'
    if (url.includes('/node_modules/')) return 'unattributed-installed-package'
    if (/^(?:file:|\/|[a-z]:\/)/i.test(url)) return 'unattributed-file-module'
    return 'unattributed-script'
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

function createNodeClassifier() {
  const groups = new Map()
  const details = new Map()
  const group = (node, frame) => {
    if (!groups.has(node.id)) groups.set(node.id, moduleGroup(frame))
    return groups.get(node.id)
  }
  const detail = (node, frame) => {
    if (!details.has(node.id)) {
      details.set(node.id, detailedModuleGroup(frame, group(node, frame)))
    }
    return details.get(node.id)
  }
  return { group, detail }
}

function recordAncestors(
  node,
  nodes,
  parents,
  delta,
  operations,
  loaderAncestors,
  emptyUrlAncestors,
  nativeLoaderSamples,
  classifier
) {
  const visited = new Set()
  let bootRecorded = false
  let loaderRecorded = false
  const isEmptyUrl = classifier.detail(node, node.callFrame) === 'unattributed-empty-url'
  let emptyUrlRecorded = !isEmptyUrl
  let nativeLoaderSeen = false
  let nativeLoaderRecorded = false
  while (node && !visited.has(node.id)) {
    visited.add(node.id)
    const frame = node.callFrame ?? {}
    const group = classifier.group(node, frame)
    const detail = classifier.detail(node, frame)
    if (detail === 'node-addon-native-custom-loader') {
      nativeLoaderSeen = true
      if (!nativeLoaderRecorded && nativeLoaderOperations.has(frame.functionName)) {
        addSample(nativeLoaderSamples, frame.functionName, delta)
        nativeLoaderRecorded = true
      }
    }
    if (!emptyUrlRecorded) {
      if (publicPackageGroups.has(detail) || loaderGroups.has(detail)) {
        addSample(emptyUrlAncestors, detail, delta)
        emptyUrlRecorded = true
      }
    }
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
    if (loaderRecorded && bootRecorded && emptyUrlRecorded && nativeLoaderRecorded) break
    node = nodes.get(parents.get(node.id))
  }
  if (!emptyUrlRecorded) {
    addSample(emptyUrlAncestors, 'unattributed-no-known-ancestor', delta)
  }
  if (nativeLoaderSeen && !nativeLoaderRecorded) {
    addSample(nativeLoaderSamples, 'unattributed-native-loader-operation', delta)
  }
}

function orderedProfileSamples(profile, nodes) {
  let timestamp = profile.startTime
  const samples = profile.samples.map((id, index) => {
    const node = nodes.get(id)
    if (!node) throw invalidProfile('core_profile_missing_sample_node')
    if (!node.callFrame) throw invalidProfile('core_profile_missing_sample_frame')
    const delta = profile.timeDeltas[index]
    if (!Number.isFinite(delta)) throw invalidProfile('core_profile_nonfinite_delta')
    timestamp += delta
    if (timestamp < profile.startTime) throw invalidProfile('core_profile_negative_delta')
    if (!Number.isFinite(timestamp) || timestamp > profile.endTime) {
      throw invalidProfile('core_profile_sample_outside_clock')
    }
    return { node, timestamp }
  })
  // CDP encodes adjacent sample timestamps, which need not arrive in time order.
  // Match DevTools CPUProfileDataModel: reconstruct timestamps, then sort the pairs.
  return samples.sort((left, right) => left.timestamp - right.timestamp)
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
    throw invalidProfile('core_profile_invalid_shape')
  }
  if (
    startupEndTimeUs !== undefined &&
    (!Number.isFinite(startupEndTimeUs) ||
      startupEndTimeUs <= profile.startTime ||
      startupEndTimeUs > profile.endTime)
  ) {
    throw invalidProfile('core_profile_invalid_marker', 'Startup marker is outside CPU profile')
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
  const emptyUrlAncestors = new Map()
  const nativeLoaderSamples = new Map()
  const classifier = createNodeClassifier()
  let sampleTime = profile.startTime
  let capturedSamples = 0
  for (const { node, timestamp } of orderedProfileSamples(profile, nodes)) {
    const capturedDelta = Math.max(
      0,
      Math.min(timestamp, startupEndTimeUs ?? profile.endTime) - sampleTime
    )
    sampleTime = timestamp
    if (capturedDelta === 0) continue
    capturedSamples += 1
    addSample(modules, classifier.group(node, node.callFrame), capturedDelta)
    const detail = classifier.detail(node, node.callFrame)
    addSample(moduleDetails, detail, capturedDelta)
    recordAncestors(
      node,
      nodes,
      parents,
      capturedDelta,
      operations,
      loaderAncestors,
      emptyUrlAncestors,
      nativeLoaderSamples,
      classifier
    )
  }
  return {
    scope: startupEndTimeUs === undefined ? 'captured-process-lifecycle' : 'startup-to-endpoint',
    durationMs: ((startupEndTimeUs ?? profile.endTime) - profile.startTime) / 1000,
    samples: capturedSamples,
    modules: rows(modules),
    bootOperations: rows(operations),
    moduleDetails: rows(moduleDetails),
    nearestLoaderAncestors: rows(loaderAncestors),
    emptyUrlAncestors: rows(emptyUrlAncestors),
    nativeLoaderOperations: rows(nativeLoaderSamples),
  }
}
