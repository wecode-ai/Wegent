#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_TIMEOUT_MS = 10_000

function usage() {
  console.error(`Usage:
  wework [path]
  wework desktop instances
  wework desktop status [--instance ID] [--project PATH]
  wework desktop inspect [--instance ID] [--project PATH] [--interactive true]
  wework desktop click (--selector CSS | --ref REF) [--inspect-id ID] [--instance ID]
  wework desktop fill (--selector CSS | --ref REF) --value TEXT [--instance ID]
  wework desktop press (--selector CSS | --ref REF) --key KEY [--instance ID]
  wework desktop wait [--selector CSS] [--text TEXT] [--timeout MS] [--instance ID]
  wework desktop screenshot --output PATH [--instance ID]
  wework desktop focus [--instance ID] [--project PATH]
  wework smart-app inspect --project ABSOLUTE_PATH [--instance ID] [--format human|json]
  wework smart-app verify --project ABSOLUTE_PATH [--instance ID] [--format human|json]
  wework smart-app pack --project ABSOLUTE_PATH --output ABSOLUTE_PATH.zip [--instance ID] [--format human|json]

Instance selection:
  --instance ID    Select an exact running Wework instance.
  --project PATH   Select the instance registered for a project.
  Default          Select the instance whose project contains the current directory,
                   otherwise require that exactly one instance is running.`)
}

export function parseCliArgs(argv) {
  const [namespace, command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (argument === '-h' || argument === '--help') {
      options.help = true
      continue
    }
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    const name = argument.slice(2)
    const value = rest[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`)
    }
    options[name] = value
    index += 1
  }
  return { namespace, command, options }
}

function registryDirectory() {
  return (
    process.env.WEWORK_DESKTOP_CONTROL_REGISTRY_DIR?.trim() ||
    join(homedir(), '.wework', 'runtime', 'desktop-instances')
  )
}

async function runningInstances() {
  const directory = registryDirectory()
  let entries
  try {
    entries = await readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const instances = []
  for (const entry of entries.filter(name => name.endsWith('.json'))) {
    try {
      const record = JSON.parse(await readFile(join(directory, entry), 'utf8'))
      if (validRuntimeRecord(record) && processIsAlive(record.pid)) instances.push(record)
    } catch {
      // Ignore incomplete and stale records while another instance is replacing them.
    }
  }
  return instances.sort((left, right) => right.startedAtUnixMs - left.startedAtUnixMs)
}

function validRuntimeRecord(record) {
  if (
    record?.schemaVersion !== 1 ||
    typeof record.instanceId !== 'string' ||
    !Number.isInteger(record.pid) ||
    typeof record.address !== 'string' ||
    typeof record.token !== 'string'
  ) {
    return false
  }
  const address = new URL(`http://${record.address}`)
  return ['127.0.0.1', '::1', 'localhost'].includes(address.hostname) && Boolean(record.token)
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function pathContains(root, candidate) {
  const path = relative(resolve(root), resolve(candidate))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

export function selectInstance(instances, options, cwd = process.cwd()) {
  if (options.instance) {
    const selected = instances.find(instance => instance.instanceId === options.instance)
    if (!selected) throw new Error(`Wework instance is not running: ${options.instance}`)
    return selected
  }
  const project = resolve(options.project || cwd)
  const projectMatches = instances.filter(
    instance => instance.projectRoot && pathContains(instance.projectRoot, project)
  )
  if (projectMatches.length === 1) return projectMatches[0]
  if (projectMatches.length > 1) {
    projectMatches.sort((left, right) => right.projectRoot.length - left.projectRoot.length)
    return projectMatches[0]
  }
  if (instances.length === 1) return instances[0]
  if (instances.length === 0) throw new Error('No running Wework desktop instance was found')
  throw new Error('Multiple Wework instances are running; pass --instance or --project')
}

async function request(instance, path, body) {
  const timeoutMs = Number(body?.timeoutMs) || DEFAULT_TIMEOUT_MS
  const signal = AbortSignal.timeout(timeoutMs + 1_000)
  const response = await fetch(`http://${instance.address}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${instance.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })
  const value = await response.json()
  if (!response.ok || value.ok === false) {
    throw new Error(value.error || `Wework desktop control failed with ${response.status}`)
  }
  return value.data
}

function optionalBoolean(value, name) {
  if (value === undefined) return undefined
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`--${name} must be "true" or "false"`)
}

function actionRequest(command, options) {
  const timeoutMs = options.timeout ? Number(options.timeout) : DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout must be a finite positive number')
  }
  const base = {
    action: command,
    selector: options.selector,
    ref: options.ref,
    inspectId: options['inspect-id'],
    index: options.index === undefined ? undefined : Number(options.index),
    timeoutMs,
  }
  if (command === 'inspect') {
    return {
      ...base,
      options: {
        interactiveOnly: optionalBoolean(options.interactive, 'interactive') ?? false,
      },
    }
  }
  if (command === 'fill') {
    if (options.value === undefined) throw new Error('--value is required')
    return { ...base, text: options.value }
  }
  if (command === 'press') {
    if (!options.key) throw new Error('--key is required')
    return { ...base, key: options.key }
  }
  if (command === 'wait') {
    return { ...base, text: options.text }
  }
  return base
}

export function smartAppRequest(command, options) {
  if (!['inspect', 'verify', 'pack'].includes(command)) {
    throw new Error(`Unknown smart-app command: ${command}`)
  }
  const allowed = new Set([
    'project',
    'instance',
    'format',
    ...(command === 'pack' ? ['output'] : []),
  ])
  const unknown = Object.keys(options).find(option => !allowed.has(option))
  if (unknown) throw new Error(`Unknown smart-app option: --${unknown}`)
  if (!options.project) throw new Error('--project is required for smart-app commands')
  if (!isAbsolute(options.project)) throw new Error('--project must be an absolute path')
  const format = options.format ?? 'human'
  if (format !== 'human' && format !== 'json') throw new Error('--format must be "human" or "json"')
  const request = { action: command, projectRoot: resolve(options.project), format }
  if (command !== 'pack') return request
  if (!options.output) throw new Error('--output is required for smart-app pack')
  if (!isAbsolute(options.output)) throw new Error('--output must be an absolute path')
  if (!options.output.toLowerCase().endsWith('.zip')) {
    throw new Error('--output must end with .zip')
  }
  return { ...request, outputPath: resolve(options.output) }
}

export function summarizeSmartAppResult(result) {
  const report = result?.report ?? result
  const status = typeof report?.status === 'string' ? report.status : 'unavailable'
  const stages = Array.isArray(report?.stages) ? report.stages : []
  const runtime = stages.find(stage => stage?.stage === 'runtime')
  const issue = Array.isArray(report?.issues) ? report.issues[0] : null
  return [
    `Smart App verification: ${status}`,
    runtime ? `Runtime: ${runtime.status}` : null,
    typeof issue?.code === 'string' ? issue.code : null,
  ]
    .filter(Boolean)
    .join('\n')
}

async function main() {
  const { namespace, command, options } = parseCliArgs(process.argv.slice(2))
  if (
    ['desktop', 'smart-app'].includes(namespace) &&
    (['-h', '--help'].includes(command) || options.help === true)
  ) {
    usage()
    return
  }
  if (!['desktop', 'smart-app'].includes(namespace) || !command) {
    usage()
    process.exitCode = 2
    return
  }
  const instances = await runningInstances()
  if (namespace === 'smart-app') {
    const input = smartAppRequest(command, options)
    const instance = selectInstance(instances, options)
    const { format, ...body } = input
    const result = await request(instance, '/smart-app', body)
    if (input.format === 'json') console.log(JSON.stringify(result, null, 2))
    else console.log(summarizeSmartAppResult(result))
    const report = result?.report ?? result
    if (report?.status !== 'passed') process.exitCode = 1
    return
  }
  if (command === 'instances') {
    console.log(
      JSON.stringify(
        instances.map(({ token: _token, ...instance }) => instance),
        null,
        2
      )
    )
    return
  }
  const instance = selectInstance(instances, options)
  if (command === 'status') {
    console.log(JSON.stringify(await request(instance, '/status'), null, 2))
    return
  }
  if (command === 'focus') {
    console.log(JSON.stringify(await request(instance, '/desktop', { action: 'focus' }), null, 2))
    return
  }
  if (!['inspect', 'click', 'fill', 'press', 'wait', 'screenshot'].includes(command)) {
    usage()
    process.exitCode = 2
    return
  }
  if (
    ['click', 'fill', 'press'].includes(command) &&
    !options.selector &&
    !options.ref &&
    options.index === undefined
  ) {
    throw new Error(`wework desktop ${command} requires --selector, --ref, or --index`)
  }
  const result = await request(instance, '/desktop', actionRequest(command, options))
  if (command === 'screenshot') {
    if (!options.output) throw new Error('--output is required')
    if (
      typeof result?.dataUrl !== 'string' ||
      !result.dataUrl.startsWith('data:image/png;base64,')
    ) {
      throw new Error('Wework returned an invalid screenshot')
    }
    const output = resolve(options.output)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(
      output,
      Buffer.from(result.dataUrl.slice('data:image/png;base64,'.length), 'base64')
    )
    console.log(output)
    return
  }
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`wework: ${error?.message || error}`)
    process.exitCode = 1
  })
}
