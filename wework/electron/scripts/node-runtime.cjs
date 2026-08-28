const { existsSync } = require('node:fs')
const { delimiter, join } = require('node:path')
const { spawnSync } = require('node:child_process')

function resolveNodeRuntime(
  environment = process.env,
  platform = process.platform,
  currentExecutable = process.execPath
) {
  const configured = environment.WEWORK_NODE_BINARY?.trim()
  if (configured) {
    if (isPlainNodeRuntime(configured, environment)) return configured
    throw new Error(`WEWORK_NODE_BINARY is not a plain Node.js runtime: ${configured}`)
  }

  const executableName = platform === 'win32' ? 'node.exe' : 'node'
  const candidates = [
    currentExecutable,
    ...(environment.PATH || '')
      .split(delimiter)
      .filter(Boolean)
      .map(directory => join(directory, executableName)),
  ]
  for (const candidate of [...new Set(candidates)]) {
    if (isPlainNodeRuntime(candidate, environment)) return candidate
  }
  throw new Error(
    'A plain Node.js runtime is required. Set WEWORK_NODE_BINARY to its absolute path.'
  )
}

function isPlainNodeRuntime(candidate, environment = process.env) {
  if (!existsSync(candidate)) return false
  const result = spawnSync(
    candidate,
    [
      '-e',
      'process.stdout.write(JSON.stringify({node:process.versions.node,electron:process.versions.electron||null}))',
    ],
    {
      encoding: 'utf8',
      env: environment,
      timeout: 5_000,
      windowsHide: true,
    }
  )
  if (result.status !== 0) return false
  try {
    const runtime = JSON.parse(result.stdout)
    return typeof runtime.node === 'string' && runtime.electron === null
  } catch {
    return false
  }
}

module.exports = {
  isPlainNodeRuntime,
  resolveNodeRuntime,
}
