import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'

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
    `WeWork_${version}_macos_arm64.zip.blockmap`,
    `WeWork_${version}_macos_x64.zip.blockmap`,
    `WeWork_${version}_windows_x64-setup.exe.blockmap`,
    `WeWork_${version}_macos_arm64.app.tar.gz`,
    `WeWork_${version}_macos_x64.app.tar.gz`,
  ]) {
    await writeFile(resolve(assets, name), name)
  }
  for (const [platform, arch] of [
    ['macos', 'arm64'],
    ['macos', 'x64'],
    ['windows', 'x64'],
    ['linux', 'x64'],
  ]) {
    const components = {}
    for (const [id, componentVersion] of [
      ['coreDsh', '0.1.1-rc.2'],
      ['executor', 'wework-abc123'],
    ]) {
      const archive = `${platform}-${arch}-${id}`
      const archiveSha256 = createHash('sha256').update(archive).digest('hex')
      const assetName = `WeworkComponent_${id}_${archiveSha256}_${platform}_${arch}.tar.gz`
      await writeFile(resolve(assets, assetName), archive)
      components[id] = {
        version: componentVersion,
        contentSha256: 'a'.repeat(64),
        archiveSha256,
        assetName,
        entryPath: '.',
      }
    }
    await writeFile(
      resolve(assets, `components-${platform}-${arch}.json`),
      JSON.stringify({
        schemaVersion: 1,
        appVersion: version,
        platform,
        arch,
        components,
      })
    )
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
    'a'.repeat(40),
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
  const components = JSON.parse(
    await readFile(resolve(output, 'components-stable-macos-arm64.json'), 'utf8')
  )
  expect(components.sourceSha).toBe('a'.repeat(40))
  expect(components.components.coreDsh).toMatchObject({
    version: '0.1.1-rc.2',
    contentSha256: 'a'.repeat(64),
    archiveBytes: 'macos-arm64-coreDsh'.length,
    downloadUrl: `https://github.com/wecode-ai/Wegent/releases/download/wework-updater/WeworkComponent_coreDsh_${createHash('sha256').update('macos-arm64-coreDsh').digest('hex')}_macos_arm64.tar.gz`,
  })
  expect(components.components.coreDsh.archiveSha256).toMatch(/^[0-9a-f]{64}$/)
  expect(components.components.executor.downloadUrl).toBe(
    `https://github.com/wecode-ai/Wegent/releases/download/wework-v1.2.3/WeworkComponent_executor_${createHash('sha256').update('macos-arm64-executor').digest('hex')}_macos_arm64.tar.gz`
  )
})

test('rejects a release without every differential update blockmap', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'wework-release-blockmaps-'))
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
    `WeWork_${version}_macos_arm64.zip.blockmap`,
    `WeWork_${version}_windows_x64-setup.exe.blockmap`,
  ]) {
    await writeFile(resolve(assets, name), name)
  }
  await writeFile(notes, '## Changes\n')

  await expect(
    run([
      resolve(process.cwd(), 'scripts/generate-desktop-update-manifests.mjs'),
      assets,
      output,
      version,
      'stable',
      'wecode-ai/Wegent',
      'wework-v1.2.3',
      notes,
      'a'.repeat(40),
    ])
  ).rejects.toThrow('manifest generator exited with code 1')
})

test('rejects an invalid release source SHA', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'wework-release-source-sha-'))
  temporaryDirectories.push(root)
  const notes = resolve(root, 'notes.md')
  await writeFile(notes, '## Changes\n')

  await expect(
    run([
      resolve(process.cwd(), 'scripts/generate-desktop-update-manifests.mjs'),
      root,
      resolve(root, 'output'),
      '1.2.3',
      'stable',
      'wecode-ai/Wegent',
      'wework-v1.2.3',
      notes,
      'not-a-source-sha',
    ])
  ).rejects.toThrow('manifest generator exited with code 1')
})

function run(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`manifest generator exited with code ${code}`))
    })
  })
}
