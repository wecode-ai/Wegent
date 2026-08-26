#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

const REQUIRED_FILES = ['plugin-manifest.json', 'PLUGIN.md', 'INSTALL.zh-CN.md']
const PACKAGE_TYPE = 'deepseek-harness-plugin-bundle'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

function commandVersion(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32' })
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
  if (!keywords) {
    fail('Search keywords are required')
    return
  }
  const url = new URL('https://registry.npmjs.org/-/v1/search')
  url.searchParams.set('text', `keywords:dsh-plugin ${keywords}`)
  url.searchParams.set('size', '20')
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'wework-smart-app-builder/0.1.0' },
  })
  if (!response.ok) {
    fail(`DSH plugin search failed: HTTP ${response.status}`)
    return
  }
  const payload = await response.json()
  const packages = (payload.objects ?? []).map(entry => ({
    name: entry.package?.name,
    version: entry.package?.version,
    description: entry.package?.description,
    links: entry.package?.links,
  }))
  process.stdout.write(`${JSON.stringify(packages, null, 2)}\n`)
}

function readManifest(root) {
  const path = join(root, 'plugin-manifest.json')
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`plugin-manifest.json is invalid: ${error.message}`)
  }
}

function validate(rootArgument) {
  const root = resolve(rootArgument)
  const issues = []
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(root, file))) issues.push(`${file} is missing`)
  }
  let manifest
  try {
    manifest = readManifest(root)
  } catch (error) {
    issues.push(error.message)
  }
  if (manifest) {
    if (manifest.type !== PACKAGE_TYPE) issues.push(`type must be ${PACKAGE_TYPE}`)
    for (const field of ['name', 'displayName', 'version', 'description']) {
      if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
        issues.push(`${field} is required`)
      }
    }
    const installPackage = manifest.entry?.installPackage
    if (typeof installPackage !== 'string' || !installPackage.trim()) {
      issues.push('entry.installPackage is required')
    } else {
      const packageRoot = resolve(root, installPackage)
      const packageRelative = relative(root, packageRoot)
      if (
        !packageRelative ||
        packageRelative.startsWith('..') ||
        isAbsolute(packageRelative) ||
        !existsSync(packageRoot)
      ) {
        issues.push('entry.installPackage must resolve inside the Smart app directory')
      } else {
        if (!existsSync(join(packageRoot, 'package.json'))) {
          issues.push('the install package has no package.json')
        }
        if (!existsSync(join(packageRoot, 'cordis.patch.yml'))) {
          issues.push('the install package has no cordis.patch.yml')
        }
      }
    }
    if (typeof manifest.entry?.profile !== 'string' || !manifest.entry.profile.trim()) {
      issues.push('entry.profile is required')
    }
    if (typeof manifest.requirements?.dsh !== 'string' || !manifest.requirements.dsh.trim()) {
      issues.push('requirements.dsh is required')
    }
    if (typeof manifest.requirements?.node !== 'string' || !manifest.requirements.node.trim()) {
      issues.push('requirements.node is required')
    }
  }
  const result = { root, valid: issues.length === 0, issues }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (issues.length > 0) process.exitCode = 1
  return result.valid
}

function walkForSecrets(root, relative = '') {
  const blocked = []
  for (const name of readdirSync(join(root, relative))) {
    const next = join(relative, name)
    const entry = lstatSync(join(root, next))
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (['.git', 'node_modules', 'test-results'].includes(name)) continue
      blocked.push(...walkForSecrets(root, next))
    } else if (name === '.env' || name.startsWith('.env.') || /\.(pem|key)$/i.test(name)) {
      blocked.push(next)
    }
  }
  return blocked
}

function pack(rootArgument, outputArgument) {
  const root = resolve(rootArgument)
  if (!validate(root)) return
  const blocked = walkForSecrets(root)
  if (blocked.length > 0) {
    fail(`Refusing to package possible secrets: ${blocked.join(', ')}`)
    return
  }
  const output = resolve(outputArgument || join(dirname(root), `${basename(root)}.zip`))
  if (extname(output).toLowerCase() !== '.zip') {
    fail('Package output must end with .zip')
    return
  }
  const outputRelative = relative(root, output)
  if (outputRelative && !outputRelative.startsWith('..') && !isAbsolute(outputRelative)) {
    fail('Package output must be outside the Smart app directory')
    return
  }
  rmSync(output, { force: true })
  if (process.platform === 'win32') {
    execFileSync(
      'tar.exe',
      [
        '-a',
        '-c',
        '-f',
        output,
        '--exclude=node_modules',
        '--exclude=.git',
        '--exclude=test-results',
        '--exclude=.DS_Store',
        '-C',
        root,
        '.',
      ],
      { stdio: 'inherit' }
    )
  } else {
    execFileSync(
      'zip',
      ['-qr', output, '.', '-x', 'node_modules/*', '.git/*', 'test-results/*', '*.DS_Store'],
      { cwd: root, stdio: 'inherit' }
    )
  }
  process.stdout.write(`${JSON.stringify({ output }, null, 2)}\n`)
}

const [command, ...args] = process.argv.slice(2)
switch (command) {
  case 'doctor':
    doctor()
    break
  case 'search':
    await search(args.join(' '))
    break
  case 'validate':
    if (!args[0]) fail('Usage: smart-app-tool.mjs validate <directory>')
    else validate(args[0])
    break
  case 'pack':
    if (!args[0]) fail('Usage: smart-app-tool.mjs pack <directory> [output.zip]')
    else pack(args[0], args[1])
    break
  default:
    fail('Usage: smart-app-tool.mjs <doctor|search|validate|pack> ...')
}
