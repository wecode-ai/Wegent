import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import { SmartAppVerifier, type SmartAppVerifierDependencies } from './smart-app-verifier.js'
import { fingerprintSmartAppDirectory } from './smart-app-verification-fingerprint.js'
import type { SmartAppVerificationIssue } from './smart-app-verification-types.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('SmartAppVerifier', () => {
  test('runs verification gates in order and persists a portable report', async () => {
    const root = await project()
    const order: string[] = []
    const verifier = createVerifier(dependencies({ order }))

    const report = await verifier.verify(root)

    expect(order).toEqual(['manifest', 'scripts', 'artifacts', 'runtime'])
    expect(report).toMatchObject({
      status: 'passed',
      projectRoot: root,
      inputFingerprint: 'input-fingerprint',
      deliverableFingerprint: 'deliverable-fingerprint',
      issues: [],
      stages: [
        { stage: 'manifest', status: 'passed' },
        { stage: 'scripts', status: 'passed' },
        { stage: 'artifacts', status: 'passed' },
        { stage: 'runtime', status: 'passed' },
      ],
    })
    const persisted = JSON.parse(
      await readFile(join(root, 'test-results/smart-app/verification.json'), 'utf8')
    )
    expect(persisted.projectRoot).toBe('.')
  })

  test('stops after a blocking issue and marks later gates skipped', async () => {
    const root = await project()
    const order: string[] = []
    const verifier = createVerifier(
      dependencies({
        order,
        scripts: { scripts: [], issues: [issue('SA-SCRIPTS-TEST', 'scripts')] },
      })
    )

    const report = await verifier.verify(root)

    expect(order).toEqual(['manifest', 'scripts'])
    expect(report.status).toBe('failed')
    expect(report.stages.map(stage => stage.status)).toEqual([
      'passed',
      'failed',
      'skipped',
      'skipped',
    ])
  })

  test('turns an unavailable project toolchain into a structured blocking report', async () => {
    const root = await project()
    const verifier = createVerifier(
      dependencies({
        runScripts: vi.fn().mockRejectedValue(new Error('runtime toolchain unavailable')),
      })
    )

    await expect(verifier.verify(root)).resolves.toMatchObject({
      status: 'failed',
      issues: [expect.objectContaining({ code: 'SA-ENV-SCRIPTS', stage: 'environment' })],
      stages: [
        { stage: 'manifest', status: 'passed' },
        { stage: 'scripts', status: 'failed' },
        { stage: 'artifacts', status: 'skipped' },
        { stage: 'runtime', status: 'skipped' },
      ],
    })
  })

  test('shares an in-flight verification for one root while allowing other roots to proceed', async () => {
    const first = await project()
    const second = await project()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const runScripts = vi.fn(async () => {
      await gate
      return { scripts: [], issues: [] }
    })
    const verifier = createVerifier(dependencies({ runScripts }))

    const firstRequest = verifier.verify(first)
    const duplicateRequest = verifier.verify(first)
    const secondRequest = verifier.verify(second)
    await vi.waitFor(() => expect(runScripts).toHaveBeenCalledTimes(2))
    release()

    const [firstReport, duplicateReport, secondReport] = await Promise.all([
      firstRequest,
      duplicateRequest,
      secondRequest,
    ])
    expect(firstReport).toEqual(duplicateReport)
    expect(secondReport.projectRoot).toBe(second)
    expect(runScripts).toHaveBeenCalledTimes(2)
  })

  test('marks changed runtime inputs stale but ignores documentation changes', async () => {
    const root = await project()
    const verifier = createVerifier(
      dependencies({
        fingerprint: fingerprintSmartAppDirectory,
      })
    )
    await verifier.verify(root)

    await writeFile(join(root, 'README.md'), 'documentation only\n')
    await expect(verifier.inspect(root)).resolves.toMatchObject({ status: 'passed' })

    await writeFile(join(root, 'source.js'), 'export const changed = true\n')
    await expect(verifier.inspect(root)).resolves.toMatchObject({
      status: 'stale',
      projectRoot: root,
    })
  })

  test('returns null when no report has been written', async () => {
    const root = await project()
    await expect(createVerifier(dependencies()).inspect(root)).resolves.toBeNull()
  })
})

function createVerifier(deps: SmartAppVerifierDependencies): SmartAppVerifier {
  return new SmartAppVerifier(
    { runtimeRoot: '/runtime', environment: { PATH: '/managed/bin' } },
    deps
  )
}

function dependencies(
  overrides: {
    order?: string[]
    scripts?: { scripts: []; issues: SmartAppVerificationIssue[] }
    runScripts?: SmartAppVerifierDependencies['runScripts']
    fingerprint?: SmartAppVerifierDependencies['fingerprint']
  } = {}
): SmartAppVerifierDependencies {
  const order = overrides.order ?? []
  return {
    validatePackage: vi.fn(async path => {
      order.push('manifest')
      return { path, manifest: manifest(), sha256: 'package-sha' }
    }),
    parseContract: vi.fn(() => ({ contract: contract(), issues: [] })),
    runScripts:
      overrides.runScripts ??
      vi.fn(async () => {
        order.push('scripts')
        return overrides.scripts ?? { scripts: [], issues: [] }
      }),
    validateArtifacts: vi.fn(async () => {
      order.push('artifacts')
      return { issues: [] }
    }),
    verifyRuntime: vi.fn(async () => {
      order.push('runtime')
      return { issues: [] }
    }),
    fingerprint:
      overrides.fingerprint ??
      vi.fn(async (_root, purpose) =>
        purpose === 'verification-input' ? 'input-fingerprint' : 'deliverable-fingerprint'
      ),
    now: vi
      .fn()
      .mockReturnValueOnce(new Date('2026-09-04T00:00:00.000Z'))
      .mockReturnValue(new Date('2026-09-04T00:00:01.000Z')),
  }
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wework-smart-app-verifier-'))
  roots.push(root)
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ scripts: { typecheck: 'true', test: 'true', build: 'true' } })}\n`
  )
  await writeFile(join(root, 'smart-app.verify.json'), `${JSON.stringify(contract())}\n`)
  await writeFile(join(root, 'source.js'), 'export const value = true\n')
  return realpath(root)
}

function manifest(): WorkbenchAppManifest {
  return {
    name: 'fixture',
    displayName: 'Fixture',
    version: '1.0.0',
    type: 'deepseek-harness-plugin-bundle',
    description: 'Fixture',
    entry: { installPackage: 'package', profile: 'web' },
    requirements: { dsh: '0.1.0-rc.8', node: '>=22' },
  }
}

function contract() {
  return {
    schemaVersion: 1 as const,
    scripts: { typecheck: 'typecheck', test: 'test', build: 'build' },
    capabilities: { host: false, client: true, remote: false },
    runtime: { profile: 'web', path: '/', readySelector: 'body' },
  }
}

function issue(code: string, stage: SmartAppVerificationIssue['stage']): SmartAppVerificationIssue {
  return {
    code,
    stage,
    file: null,
    message: code,
    expected: null,
    actual: null,
    blocking: true,
    hint: null,
  }
}
