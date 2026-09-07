#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { basename, dirname, resolve } from 'node:path'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

function commandVersion(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false })
  if (result.error || result.status !== 0) return null
  return (result.stdout || result.stderr).trim()
}

function doctor() {
  const nodeMajor = Number(process.versions.node.split('.')[0])
  const pnpmVersion = commandVersion('corepack', ['pnpm', '--version'])
  const result = {
    node: process.version,
    nodeSupported: nodeMajor >= 22,
    pnpm: pnpmVersion,
    pnpmAvailable: Boolean(pnpmVersion),
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (!result.nodeSupported) fail('Node.js 22 or newer is required')
  if (!result.pnpmAvailable) fail('Corepack pnpm is required')
}

async function search(query) {
  const keywords = query.trim()
  if (!keywords) return fail('Search keywords are required')
  const url = new URL('https://registry.npmjs.org/-/v1/search')
  url.searchParams.set('text', `keywords:dsh-plugin ${keywords}`)
  url.searchParams.set('size', '20')
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'wework-smart-app-builder/0.1.0' },
  })
  if (!response.ok) return fail(`DSH plugin search failed: HTTP ${response.status}`)
  const payload = await response.json()
  const packages = (payload.objects ?? []).map(entry => ({
    name: entry.package?.name,
    version: entry.package?.version,
    description: entry.package?.description,
    links: entry.package?.links,
  }))
  process.stdout.write(`${JSON.stringify(packages, null, 2)}\n`)
}

function runWeworkSmartApp(command, rootArgument, outputArgument) {
  const root = resolve(rootArgument)
  const args = ['smart-app', command, '--project', root, '--format', 'json']
  if (command === 'pack') {
    const output = resolve(outputArgument || `${dirname(root)}/${basename(root)}.zip`)
    args.push('--output', output)
  }
  const result = spawnSync('wework', args, { encoding: 'utf8', shell: false })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) return fail(`Wework Smart App ${command} failed: ${result.error.message}`)
  if (result.status !== 0) process.exitCode = result.status || 1
}

const [command, ...args] = process.argv.slice(2)
switch (command) {
  case 'doctor':
    doctor()
    break
  case 'search':
    await search(args.join(' '))
    break
  case 'inspect':
  case 'verify':
    if (!args[0]) fail(`Usage: smart-app-tool.mjs ${command} <directory>`)
    else runWeworkSmartApp(command, args[0])
    break
  case 'pack':
    if (!args[0]) fail('Usage: smart-app-tool.mjs pack <directory> [output.zip]')
    else runWeworkSmartApp('pack', args[0], args[1])
    break
  default:
    fail('Usage: smart-app-tool.mjs <doctor|search|inspect|verify|pack> ...')
}
