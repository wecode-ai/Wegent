#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create } from 'tar'

const weworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installerRoot = join(weworkRoot, 'electron', 'release-installer')
const [platform, arch, version, outputDirectory] = process.argv.slice(2)

if (!platform || !arch || !version || !outputDirectory) {
  throw new Error(
    'Usage: prepare-desktop-release-assets.mjs <macos|windows|linux> <arm64|x64> <version> <output-directory>'
  )
}

const output = resolve(outputDirectory)
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })

if (platform === 'macos') {
  const appDirectory = await findDirectory(installerRoot, /^mac(?:-arm64)?$/)
  const appPath = join(appDirectory, 'WeWork.app')
  await requireDirectory(appPath)
  const dmg = await findFile(
    installerRoot,
    new RegExp(`^WeWork_${escape(version)}_macos_${arch}\\.dmg$`)
  )
  const zip = await findFile(
    installerRoot,
    new RegExp(`^WeWork_${escape(version)}_macos_${arch}\\.zip$`)
  )
  const bridge = join(output, `WeWork_${version}_macos_${arch}.app.tar.gz`)
  await create({ cwd: appDirectory, file: bridge, gzip: true, portable: true }, ['WeWork.app'])
  await Promise.all([cp(dmg, join(output, basename(dmg))), cp(zip, join(output, basename(zip)))])
  await signBridge(bridge)
} else if (platform === 'windows') {
  const installer = await findFile(
    installerRoot,
    new RegExp(`^WeWork_${escape(version)}_windows_${arch}-setup\\.exe$`)
  )
  const target = join(output, basename(installer))
  await cp(installer, target)
  const blockmap = `${installer}.blockmap`
  if (await isFile(blockmap)) await cp(blockmap, `${target}.blockmap`)
  await signBridge(target)
} else if (platform === 'linux') {
  const appImage = await findFile(
    installerRoot,
    new RegExp(`^WeWork_${escape(version)}_linux_${arch}\\.AppImage$`)
  )
  await cp(appImage, join(output, basename(appImage)))
} else {
  throw new Error(`Unsupported desktop release platform: ${platform}`)
}

async function signBridge(path) {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()) {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY is required for legacy updater bridge assets.')
  }
  await run(
    'pnpm',
    ['--dir', join(weworkRoot, 'electron'), 'exec', 'tauri', 'signer', 'sign', path],
    weworkRoot
  )
}

async function findDirectory(root, pattern) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && pattern.test(entry.name)) return join(root, entry.name)
  }
  throw new Error(`No directory matching ${pattern} under ${root}`)
}

async function findFile(root, pattern) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && pattern.test(entry.name)) return join(root, entry.name)
  }
  throw new Error(`No file matching ${pattern} under ${root}`)
}

async function requireDirectory(path) {
  if (!(await stat(path).catch(() => null))?.isDirectory()) {
    throw new Error(`Required application directory is missing: ${path}`)
  }
}

async function isFile(path) {
  return (await stat(path).catch(() => null))?.isFile() === true
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}
