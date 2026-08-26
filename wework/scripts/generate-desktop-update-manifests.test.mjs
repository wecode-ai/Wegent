import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { spawn } from 'node:child_process'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))
  )
})

test('generates Electron and legacy Tauri rolling manifests from one release', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'wework-release-manifests-'))
  temporaryDirectories.push(root)
  const assets = resolve(root, 'assets')
  const output = resolve(root, 'output')
  const notes = resolve(root, 'notes.md')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(assets))
  const version = '1.2.3'
  for (const name of [
    `WeWork_${version}_macos_arm64.zip`,
    `WeWork_${version}_macos_x64.zip`,
    `WeWork_${version}_windows_x64-setup.exe`,
    `WeWork_${version}_macos_arm64.app.tar.gz`,
    `WeWork_${version}_macos_x64.app.tar.gz`,
  ]) {
    await writeFile(resolve(assets, name), name)
  }
  for (const name of [
    `WeWork_${version}_macos_arm64.app.tar.gz.sig`,
    `WeWork_${version}_macos_x64.app.tar.gz.sig`,
    `WeWork_${version}_windows_x64-setup.exe.sig`,
  ]) {
    await writeFile(resolve(assets, name), `signature-${name}`)
  }
  await writeFile(notes, '## Changes\n\n- Smooth migration')

  await run([
    resolve(process.cwd(), 'scripts/generate-desktop-update-manifests.mjs'),
    assets,
    output,
    version,
    'stable',
    'wecode-ai/Wegent',
    'wework-v1.2.3',
    notes,
  ])

  const electron = await readFile(resolve(output, 'latest-mac.yml'), 'utf8')
  expect(electron).toContain(`WeWork_${version}_macos_arm64.zip`)
  expect(electron).toContain(`WeWork_${version}_macos_x64.zip`)
  expect(await readFile(resolve(output, 'beta.yml'), 'utf8')).toContain(
    `WeWork_${version}_windows_x64-setup.exe`
  )
  const legacy = JSON.parse(await readFile(resolve(output, 'stable-darwin-aarch64.json'), 'utf8'))
  expect(legacy.platforms['stable-darwin']).toEqual({
    signature: `signature-WeWork_${version}_macos_arm64.app.tar.gz.sig`,
    url: `https://github.com/wecode-ai/Wegent/releases/download/wework-v1.2.3/WeWork_${version}_macos_arm64.app.tar.gz`,
  })
})

test('generates a MinIO macOS architecture release without requiring other targets', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'wework-minio-release-manifests-'))
  temporaryDirectories.push(root)
  const assets = resolve(root, 'assets')
  const output = resolve(root, 'output')
  const notes = resolve(root, 'notes.md')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(assets))
  const version = '1.2.4-beta.1'
  for (const name of [
    `WeWork_${version}_macos_arm64.zip`,
    `WeWork_${version}_macos_arm64.app.tar.gz`,
  ]) {
    await writeFile(resolve(assets, name), name)
  }
  await writeFile(
    resolve(assets, `WeWork_${version}_macos_arm64.app.tar.gz.sig`),
    'migration-signature'
  )
  await writeFile(notes, 'MinIO migration')

  await run(
    [
      resolve(process.cwd(), 'scripts/generate-desktop-update-manifests.mjs'),
      assets,
      output,
      version,
      'beta',
      'internal/minio',
      `minio-${version}`,
      notes,
    ],
    {
      WEWORK_RELEASE_BASE_URL: 'https://minio.example/releases/wework/macos',
      WEWORK_RELEASE_TARGETS: 'macos-arm64',
    }
  )

  const electron = await readFile(resolve(output, 'beta-mac.yml'), 'utf8')
  expect(electron).toContain(
    `https://minio.example/releases/wework/macos/WeWork_${version}_macos_arm64.zip`
  )
  const bridge = JSON.parse(await readFile(resolve(output, 'latest.json'), 'utf8'))
  expect(bridge.platforms).toEqual({
    'darwin-aarch64': {
      signature: 'migration-signature',
      url: `https://minio.example/releases/wework/macos/WeWork_${version}_macos_arm64.app.tar.gz`,
    },
  })
  await expect(readFile(resolve(output, 'beta.yml'), 'utf8')).rejects.toThrow()
})

function run(args, extraEnvironment = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...extraEnvironment },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`manifest generator exited with code ${code}`))
    })
  })
}
