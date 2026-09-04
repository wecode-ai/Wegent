import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import { validateSmartAppArtifacts } from './smart-app-artifact-validator.js'
import { scaffoldSmartApp, type SmartAppTemplate } from './smart-app-scaffold.js'
import type { SmartAppVerificationContract } from './smart-app-verification-types.js'

const fixtureRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'smart-apps',
  'artifacts'
)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('validateSmartAppArtifacts', () => {
  test('accepts a real Client ModuleLoader registration without requiring Host import', async () => {
    const projectRoot = fixture('valid-client')

    await expect(validateFixture(projectRoot, capabilities(false, true, false))).resolves.toEqual({
      issues: [],
    })
  })

  test('requires package metadata to be exported for Client discovery', async () => {
    const result = await validateFixture(
      fixture('missing-package-export'),
      capabilities(false, true, false)
    )

    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'SA-CLIENT-PACKAGE-EXPORT', stage: 'artifacts' })
    )
  })

  test('executes Client output in a controlled loader instead of searching its source', async () => {
    const result = await validateFixture(
      fixture('invalid-module-loader'),
      capabilities(false, true, false)
    )

    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'SA-CLIENT-MODULE-LOADER', stage: 'artifacts' })
    )
  })

  test('does not inspect a Client entry for a pure Host contract', async () => {
    const root = await copiedFixture('invalid-module-loader')
    const result = await validateFixture(root, capabilities(true, false, false))

    expect(result.issues).toEqual([])
  })

  test('reports a Host entry that cannot be imported in isolation', async () => {
    const root = await copiedFixture('valid-client')
    await writeFile(join(root, 'package', 'index.js'), "throw new Error('broken host')\n")
    const result = await validateFixture(root, capabilities(true, false, false))

    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'SA-HOST-IMPORT', stage: 'artifacts' })
    )
  })

  test('requires declared Client and Remote exports to exist and be included in files', async () => {
    const root = await copiedFixture('valid-client')
    const packagePath = join(root, 'package', 'package.json')
    const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'))
    packageManifest.exports['./client'] = './missing-client.js'
    packageManifest.exports['./remote'] = './missing-remote.js'
    packageManifest.exports['./typert'] = './missing-typert.js'
    await writeFile(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`)

    const result = await validateFixture(root, capabilities(true, true, true))

    expect(result.issues.map(issue => issue.code)).toEqual(
      expect.arrayContaining(['SA-CLIENT-EXPORT', 'SA-REMOTE-EXPORT'])
    )
  })

  test('cross-checks Client output and bundle patch against package files', async () => {
    const root = await copiedFixture('valid-client')
    const packagePath = join(root, 'package', 'package.json')
    const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'))
    packageManifest.files = ['index.js']
    await writeFile(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`)

    const result = await validateFixture(root, capabilities(false, true, false))

    expect(result.issues.map(issue => issue.code)).toEqual(
      expect.arrayContaining(['SA-CLIENT-FILES', 'SA-PACKAGE-BUNDLE-PATCH-FILES'])
    )
  })

  test('accepts built Remote and Typert exports included in the package', async () => {
    const root = await copiedFixture('valid-client')
    const packagePath = join(root, 'package', 'package.json')
    const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'))
    packageManifest.exports['./remote'] = './remote.js'
    packageManifest.exports['./typert'] = './typert.host.js'
    packageManifest.files.push('remote.js', 'typert.host.js')
    packageManifest.dsh.client.inject.push('@deepseek-ai/dsh-api-gateway')
    await writeFile(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`)
    await writeFile(join(root, 'package', 'remote.js'), 'export const descriptors = []\n')
    await writeFile(join(root, 'package', 'typert.host.js'), 'export const invocations = []\n')

    await expect(validateFixture(root, capabilities(true, true, true))).resolves.toEqual({
      issues: [],
    })
  })

  test('requires the registered Client module id to match its package name', async () => {
    const root = await copiedFixture('valid-client')
    await writeFile(
      join(root, 'package', 'client.js'),
      "window.__ModuleLoader__.load({ id: '@fixture/wrong', factory: () => ({}) })\n"
    )

    const result = await validateFixture(root, capabilities(false, true, false))

    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'SA-CLIENT-MODULE-ID', stage: 'artifacts' })
    )
  })

  test('requires DSH Client metadata for module discovery', async () => {
    const root = await copiedFixture('valid-client')
    const packagePath = join(root, 'package', 'package.json')
    const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'))
    delete packageManifest.dsh.client
    await writeFile(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`)

    const result = await validateFixture(root, capabilities(false, true, false))

    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: 'SA-CLIENT-METADATA', stage: 'artifacts' })
    )
  })

  test.each<SmartAppTemplate>(['web', 'host', 'web-host', 'web-host-remote'])(
    'accepts freshly generated %s artifacts',
    async template => {
      const parent = await mkdtemp(join(tmpdir(), 'wework-smart-app-generated-artifacts-'))
      roots.push(parent)
      const projectRoot = join(parent, 'generated-app')
      await scaffoldSmartApp({
        path: projectRoot,
        name: 'generated-app',
        displayName: 'Generated App',
        description: 'Generated fixture',
        dshVersion: '0.1.0-rc.8',
        template,
      })
      const manifest = JSON.parse(
        await readFile(join(projectRoot, 'plugin-manifest.json'), 'utf8')
      ) as WorkbenchAppManifest
      const contract = JSON.parse(
        await readFile(join(projectRoot, 'smart-app.verify.json'), 'utf8')
      ) as SmartAppVerificationContract

      await expect(validateSmartAppArtifacts({ projectRoot, manifest, contract })).resolves.toEqual(
        { issues: [] }
      )
    }
  )
})

function fixture(name: string): string {
  return join(fixtureRoot, name)
}

async function copiedFixture(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-artifacts-'))
  roots.push(root)
  await cp(fixture(name), root, { recursive: true })
  return root
}

async function validateFixture(projectRoot: string, contract: SmartAppVerificationContract) {
  const manifest = JSON.parse(
    await readFile(join(projectRoot, 'plugin-manifest.json'), 'utf8')
  ) as WorkbenchAppManifest
  return validateSmartAppArtifacts({ projectRoot, manifest, contract })
}

function capabilities(
  host: boolean,
  client: boolean,
  remote: boolean
): SmartAppVerificationContract {
  return {
    schemaVersion: 1,
    scripts: {
      typecheck: 'typecheck',
      test: 'test',
      build: 'build',
      ...(remote ? { runtimeProbe: 'runtime:probe' } : {}),
    },
    capabilities: { host, client, remote },
    runtime: { profile: 'web', path: '/', readySelector: 'body' },
  }
}
