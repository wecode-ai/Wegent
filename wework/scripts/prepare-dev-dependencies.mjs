#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const weworkRoot = resolve(scriptDirectory, '..')
const repositoryRoot = resolve(weworkRoot, '..')
const electronRoot = join(weworkRoot, 'electron')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

export async function fingerprintFiles(paths, salt = '') {
  const hash = createHash('sha256').update(salt)
  for (const path of paths) {
    hash
      .update('\0')
      .update(resolve(path))
      .update('\0')
      .update(await readFile(path))
  }
  return hash.digest('hex')
}

async function dependenciesAreCurrent(stampPath, fingerprint, requiredPaths) {
  try {
    const stamp = JSON.parse(await readFile(stampPath, 'utf8'))
    if (stamp.fingerprint !== fingerprint) return false
    await Promise.all(requiredPaths.map(path => access(path)))
    return true
  } catch {
    return false
  }
}

async function ensureDependencies(options) {
  const fingerprint = await fingerprintFiles(
    options.inputs,
    `${process.platform}:${process.arch}:${process.versions.modules}`
  )
  const force = process.env.WEWORK_FORCE_DEV_DEPENDENCIES === '1'
  if (!force && (await dependenciesAreCurrent(options.stampPath, fingerprint, options.required))) {
    console.log(`${options.name} dependencies are current`)
    return
  }

  console.log(`Preparing ${options.name} dependencies`)
  await options.install()
  await Promise.all(options.required.map(path => access(path)))
  await mkdir(dirname(options.stampPath), { recursive: true })
  await writeFile(options.stampPath, `${JSON.stringify({ fingerprint }, null, 2)}\n`)
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

async function ensureWorkspaceDependencies() {
  await ensureDependencies({
    name: 'Wework',
    inputs: [
      join(repositoryRoot, 'package.json'),
      join(repositoryRoot, 'pnpm-lock.yaml'),
      join(repositoryRoot, 'pnpm-workspace.yaml'),
      join(repositoryRoot, 'packages', 'chat-core', 'package.json'),
      join(weworkRoot, 'package.json'),
      join(scriptDirectory, 'prepare-dev-dependencies.mjs'),
    ],
    required: [
      join(weworkRoot, 'node_modules', '.bin', 'tsc'),
      join(weworkRoot, 'node_modules', '.bin', 'vite'),
      join(weworkRoot, 'node_modules', 'dingtalk-workspace-cli', 'package.json'),
    ],
    stampPath: join(
      weworkRoot,
      'node_modules',
      '.cache',
      'wework-dev',
      'workspace-dependencies.json'
    ),
    install: () =>
      run(pnpmCommand, ['install', '--filter', 'wework...', '--frozen-lockfile'], repositoryRoot),
  })
}

function electronExecutable() {
  if (process.platform === 'darwin') {
    return join(
      electronRoot,
      'node_modules',
      'electron',
      'dist',
      'Electron.app',
      'Contents',
      'MacOS',
      'Electron'
    )
  }
  return join(
    electronRoot,
    'node_modules',
    'electron',
    'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron'
  )
}

async function ensureElectronDependencies() {
  await ensureDependencies({
    name: 'Electron',
    inputs: [
      join(electronRoot, '.npmrc'),
      join(electronRoot, 'package.json'),
      join(electronRoot, 'pnpm-lock.yaml'),
      join(electronRoot, 'pnpm-workspace.yaml'),
      join(scriptDirectory, 'prepare-electron.mjs'),
      join(scriptDirectory, 'prepare-dev-dependencies.mjs'),
    ],
    required: [
      join(electronRoot, 'node_modules', '.bin', 'tsc'),
      join(electronRoot, 'node_modules', 'electron', 'package.json'),
      electronExecutable(),
    ],
    stampPath: join(electronRoot, 'node_modules', '.cache', 'wework-electron-dependencies.json'),
    install: () =>
      run(process.execPath, [join(scriptDirectory, 'prepare-electron.mjs')], weworkRoot),
  })
}

await ensureWorkspaceDependencies()
await ensureElectronDependencies()
