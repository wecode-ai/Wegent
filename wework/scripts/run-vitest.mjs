import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { wrapWindowsScriptCommand } from './child-process-command.mjs'

const rawArgs = process.argv.slice(2)
const requestedArgs = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const integrationTestFiles = ['scripts/dev-executor-reload.integration.mjs']
const nodeTestFiles = discoverNodeTestFiles()
const requestedIntegrationTests = requestedArgs.filter(argument =>
  integrationTestFiles.includes(normalizeArgumentPath(argument))
)
const requestedNodeTests = requestedArgs.filter(argument =>
  nodeTestFiles.includes(normalizeArgumentPath(argument))
)
const vitestArgs = requestedArgs.filter(
  argument =>
    !integrationTestFiles.includes(normalizeArgumentPath(argument)) &&
    !nodeTestFiles.includes(normalizeArgumentPath(argument))
)

if (requestedArgs.length === 0) {
  for (const path of integrationTestFiles) run(process.execPath, [path])
} else {
  for (const path of requestedIntegrationTests) run(process.execPath, [path])
}

if (requestedArgs.length === 0 || vitestArgs.length > 0) {
  run('vitest', ['run', ...vitestArgs])
}

if (requestedArgs.length === 0) {
  run(process.execPath, ['--test', ...nodeTestFiles])
} else if (requestedNodeTests.length > 0) {
  run(process.execPath, ['--test', ...requestedNodeTests])
}

function discoverNodeTestFiles() {
  return ['dsh', 'scripts']
    .flatMap(directory => listTestFiles(join(root, directory)))
    .filter(path => readFileSync(path, 'utf8').includes("from 'node:test'"))
    .map(path => relative(root, path))
    .sort()
}

function listTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listTestFiles(path)
    return entry.isFile() && entry.name.endsWith('.test.mjs') ? [path] : []
  })
}

function normalizeArgumentPath(argument) {
  return relative(root, resolve(root, argument))
}

function resolveWindowsScript(command) {
  if (process.platform !== 'win32' || command.includes('.')) {
    return command
  }
  return `${command}.cmd`
}

function run(command, args) {
  const resolved = wrapWindowsScriptCommand(resolveWindowsScript(command), args)
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: root,
    stdio: 'inherit',
  })

  if (result.error) {
    throw result.error
  }

  if (result.signal) {
    process.kill(process.pid, result.signal)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
