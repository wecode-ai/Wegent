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

test('generates Electron and component rolling manifests from one release', async () => {
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
  ]) {
    await writeFile(resolve(assets, name), name)
  }
  for (const [platform, arch] of [
    ['macos', 'arm64'],
    ['macos', 'x64'],
    ['windows', 'arm64'],
    ['windows', 'x64'],
    ['linux', 'x64'],
  ]) {
    const components = {}
    for (const [id, componentVersion] of [
      ['coreDsh', '0.1.1-rc.2'],
      ['executor', `wework-${'a'.repeat(12)}`],
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
        releaseScope: id === 'coreDsh' ? 'shared' : 'version',
        entryPath: '.',
      }
    }
    await writeFile(
      resolve(assets, `components-${platform}-${arch}.json`),
      JSON.stringify({
        schemaVersion: 1,
        appVersion: version,
        sourceSha: 'a'.repeat(40),
        platform,
        arch,
        components,
      })
    )
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
  await expect(readFile(resolve(output, 'latest-arm64.yml'))).rejects.toThrow()
  const components = JSON.parse(
    await readFile(resolve(output, 'components-stable-macos-arm64.json'), 'utf8')
  )
  expect(components.sourceSha).toBe('a'.repeat(40))
  expect(components.capabilities).toEqual({ componentizedHostUpdate: 1 })
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
  const windowsArm64 = JSON.parse(
    await readFile(resolve(output, 'components-stable-windows-arm64.json'), 'utf8')
  )
  expect(windowsArm64).toMatchObject({
    channel: 'stable',
    platform: 'windows',
    arch: 'arm64',
  })
})

test('prefers slim Host update artifacts while retaining version release URLs', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'wework-host-update-manifests-'))
  temporaryDirectories.push(root)
  const assets = resolve(root, 'assets')
  const output = resolve(root, 'output')
  const notes = resolve(root, 'notes.md')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(assets))
  const version = '1.2.3'
  for (const name of [
    `WeWorkHostUpdate_${version}_macos_arm64.zip`,
    `WeWorkHostUpdate_${version}_macos_x64.zip`,
    `WeWorkHostUpdate_${version}_windows_x64-setup.exe`,
  ]) {
    await writeFile(resolve(assets, name), name)
  }
  for (const [platform, arch] of [
    ['macos', 'arm64'],
    ['macos', 'x64'],
    ['windows', 'arm64'],
    ['windows', 'x64'],
  ]) {
    await writeFile(
      resolve(assets, `components-${platform}-${arch}.json`),
      JSON.stringify({
        schemaVersion: 1,
        appVersion: version,
        sourceSha: 'a'.repeat(40),
        platform,
        arch,
        components: {},
      })
    )
  }
  await writeFile(notes, '## Changes\n')

  await run(
    [
      resolve(process.cwd(), 'scripts/generate-desktop-update-manifests.mjs'),
      assets,
      output,
      version,
      'beta',
      'wecode-ai/Wegent',
      'wework-v1.2.3',
      notes,
      'a'.repeat(40),
    ],
    { WEWORK_USE_COMPONENTIZED_HOST_UPDATE: 'true' }
  )

  expect(await readFile(resolve(output, 'beta-mac.yml'), 'utf8')).toContain(
    `WeWorkHostUpdate_${version}_macos_arm64.zip`
  )
  expect(await readFile(resolve(output, 'beta.yml'), 'utf8')).toContain(
    `WeWorkHostUpdate_${version}_windows_x64-setup.exe`
  )
  await expect(readFile(resolve(output, 'beta-arm64.yml'))).rejects.toThrow()
  const windowsArm64 = JSON.parse(
    await readFile(resolve(output, 'components-beta-windows-arm64.json'), 'utf8')
  )
  expect(windowsArm64).toMatchObject({
    channel: 'beta',
    platform: 'windows',
    arch: 'arm64',
  })
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

async function verifiedManifestFixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'wework-verified-manifests-'))
  temporaryDirectories.push(root)
  const assets = resolve(root, 'assets')
  const output = resolve(root, 'output')
  const notes = resolve(root, 'notes.md')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(assets))
  await writeFile(notes, 'Verified release')
  for (const suffix of ['macos_arm64.zip', 'macos_x64.zip', 'windows_x64-setup.exe'])
    await writeFile(resolve(assets, `WeWork_1.2.3_${suffix}`), suffix)
  for (const [platform, arch] of [
    ['macos', 'arm64'],
    ['macos', 'x64'],
    ['windows', 'x64'],
  ]) {
    await writeFile(
      resolve(assets, `components-${platform}-${arch}.json`),
      JSON.stringify({
        schemaVersion: 1,
        appVersion: '1.2.3',
        sourceSha: 'a'.repeat(40),
        platform,
        arch,
        components: {},
      })
    )
    for (const channel of ['stable', 'beta']) {
      const releases = ['1.2.2', '1.2.3'].map((version, index) => ({
        version,
        minSourceVersion: '1.2.2',
        sha256: String(index + 1).repeat(64),
        sourceSha: 'a'.repeat(40),
        url: `https://example.com/${version}.tar.gz`,
        bytes: 1,
        dataSchema: 1,
        readableDataSchemas: [1],
        revoked: false,
      }))
      await writeFile(
        resolve(assets, `upgrade-policy-${channel}-${platform}-${arch}.json`),
        JSON.stringify({
          schemaVersion: 1,
          channel,
          platform,
          arch,
          releases,
          edges: [
            {
              from: '1.2.2',
              to: '1.2.3',
              fromSha256: releases[0].sha256,
              toSha256: releases[1].sha256,
              fromSourceSha: releases[0].sourceSha,
              toSourceSha: releases[1].sourceSha,
              runId: '123',
              evidenceSha256: 'b'.repeat(64),
              upgrade: 'passed',
              rollback: 'passed',
              revoked: false,
            },
          ],
        })
      )
    }
  }
  // The first native arm64 release has no prior arm64 package to verify. Its
  // release job publishes a self-baseline policy with no incoming edges.
  await writeFile(
    resolve(assets, 'components-windows-arm64.json'),
    JSON.stringify({
      schemaVersion: 1,
      appVersion: '1.2.3',
      sourceSha: 'a'.repeat(40),
      platform: 'windows',
      arch: 'arm64',
      components: {},
    })
  )
  for (const channel of ['stable', 'beta']) {
    await writeFile(
      resolve(assets, `upgrade-policy-${channel}-windows-arm64.json`),
      JSON.stringify({
        schemaVersion: 1,
        channel,
        platform: 'windows',
        arch: 'arm64',
        releases: [
          {
            version: '1.2.3',
            minSourceVersion: '1.2.3',
            sha256: '3'.repeat(64),
            sourceSha: 'a'.repeat(40),
            url: 'https://example.com/1.2.3.tar.gz',
            bytes: 1,
            dataSchema: 1,
            readableDataSchemas: [1],
            revoked: false,
          },
        ],
        edges: [],
      })
    )
  }
  return {
    assets,
    output,
    args: [
      resolve(process.cwd(), 'scripts/generate-desktop-update-manifests.mjs'),
      assets,
      output,
      '1.2.3',
      'stable',
      'wecode-ai/Wegent',
      'wework-v1.2.3',
      notes,
      'a'.repeat(40),
    ],
  }
}

test('publishes the CI-confirmed floor and exact edges for every platform and channel', async () => {
  const fixture = await verifiedManifestFixture()
  await run(fixture.args, { WEWORK_REQUIRE_UPGRADE_POLICY: 'true' })
  for (const [platform, arch] of [
    ['macos', 'arm64'],
    ['macos', 'x64'],
    ['windows', 'x64'],
  ]) {
    for (const channel of ['stable', 'beta']) {
      const manifest = JSON.parse(
        await readFile(
          resolve(fixture.output, `components-${channel}-${platform}-${arch}.json`),
          'utf8'
        )
      )
      expect(manifest.upgradePolicy.releases[1].minSourceVersion).toBe('1.2.2')
      expect(manifest.upgradePolicy.edges).toHaveLength(1)
      expect(manifest.upgradePolicy.edges[0]).toMatchObject({
        from: '1.2.2',
        to: '1.2.3',
        rollback: 'passed',
      })
    }
  }
})

test('publishes the first arm64 release as a self-baseline policy', async () => {
  const fixture = await verifiedManifestFixture()
  await run(fixture.args, { WEWORK_REQUIRE_UPGRADE_POLICY: 'true' })
  for (const channel of ['stable', 'beta']) {
    const manifest = JSON.parse(
      await readFile(resolve(fixture.output, `components-${channel}-windows-arm64.json`), 'utf8')
    )
    expect(manifest.upgradePolicy).toMatchObject({
      channel,
      platform: 'windows',
      arch: 'arm64',
      releases: [
        {
          version: '1.2.3',
          minSourceVersion: '1.2.3',
          sourceSha: 'a'.repeat(40),
        },
      ],
      edges: [],
    })
  }
})

test('release promotion rejects missing verification policies', async () => {
  const fixture = await verifiedManifestFixture()
  await rm(resolve(fixture.assets, 'upgrade-policy-stable-windows-x64.json'))
  await expect(run(fixture.args, { WEWORK_REQUIRE_UPGRADE_POLICY: 'true' })).rejects.toThrow(
    'manifest generator exited with code 1'
  )
})

test.each(['appVersion', 'sourceSha', 'arch'])(
  'rejects components from a mutable workspace with a different %s',
  async field => {
    const fixture = await verifiedManifestFixture()
    const file = resolve(fixture.assets, 'components-macos-arm64.json')
    const descriptor = JSON.parse(await readFile(file, 'utf8'))
    descriptor[field] = field === 'sourceSha' ? 'b'.repeat(40) : 'different'
    await writeFile(file, JSON.stringify(descriptor))
    await expect(run(fixture.args, { WEWORK_REQUIRE_UPGRADE_POLICY: 'true' })).rejects.toThrow(
      'manifest generator exited with code 1'
    )
  }
)

test('release promotion rejects a policy from another channel, source revision or package', async () => {
  const fixture = await verifiedManifestFixture()
  const path = resolve(fixture.assets, 'upgrade-policy-stable-macos-arm64.json')
  const policy = JSON.parse(await readFile(path, 'utf8'))
  for (const change of [
    value => {
      value.channel = 'beta'
    },
    value => {
      value.releases[1].version = '1.2.4'
      value.edges = []
    },
    value => {
      value.releases[1].sourceSha = 'c'.repeat(40)
      value.edges[0].toSourceSha = 'c'.repeat(40)
    },
    value => {
      value.edges[0].rollback = 'not-run'
    },
  ]) {
    const invalid = structuredClone(policy)
    change(invalid)
    await writeFile(path, JSON.stringify(invalid))
    await expect(run(fixture.args, { WEWORK_REQUIRE_UPGRADE_POLICY: 'true' })).rejects.toThrow(
      'manifest generator exited with code 1'
    )
  }
})

function run(args, environment = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...environment },
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`manifest generator exited with code ${code}`))
    })
  })
}
