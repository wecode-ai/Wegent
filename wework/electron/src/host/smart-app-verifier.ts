import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import {
  validateSmartAppArtifacts,
  type SmartAppArtifactValidationResult,
  type ValidateSmartAppArtifactsOptions,
} from './smart-app-artifact-validator.js'
import {
  validateSmartAppPackageDirectory,
  requiredSmartAppDirectory,
  SmartAppPackageValidationError,
  type ValidatedSmartAppPackage,
} from './smart-app-package-validator.js'
import {
  runSmartAppProjectScripts,
  type RunSmartAppProjectScriptsOptions,
  type SmartAppProjectScriptsResult,
} from './smart-app-project-script-runner.js'
import {
  verifySmartAppRuntime,
  type VerifySmartAppRuntimeOptions,
} from './smart-app-runtime-verifier.js'
import {
  parseSmartAppVerificationContract,
  type SmartAppVerificationContractContext,
  type SmartAppVerificationContractResult,
} from './smart-app-verification-contract.js'
import {
  fingerprintSmartAppDirectory,
  type SmartAppFingerprintPurpose,
} from './smart-app-verification-fingerprint.js'
import type {
  SmartAppVerificationContract,
  SmartAppVerificationIssue,
  SmartAppVerificationReport,
  SmartAppVerificationStage,
  SmartAppVerificationStageResult,
} from './smart-app-verification-types.js'

const REPORT_PATH = join('test-results', 'smart-app', 'verification.json')
const PIPELINE_STAGES = ['manifest', 'scripts', 'artifacts', 'runtime'] as const

export interface SmartAppVerifierOptions {
  runtimeRoot: string
  environment: NodeJS.ProcessEnv
}

export interface SmartAppVerifierDependencies {
  validatePackage: (projectRoot: string) => Promise<ValidatedSmartAppPackage>
  parseContract: (
    source: string | null,
    context: SmartAppVerificationContractContext
  ) => SmartAppVerificationContractResult
  runScripts: (options: RunSmartAppProjectScriptsOptions) => Promise<SmartAppProjectScriptsResult>
  validateArtifacts: (
    options: ValidateSmartAppArtifactsOptions
  ) => Promise<SmartAppArtifactValidationResult>
  verifyRuntime: (
    options: VerifySmartAppRuntimeOptions
  ) => Promise<{ issues: SmartAppVerificationIssue[] }>
  fingerprint: (projectRoot: string, purpose: SmartAppFingerprintPurpose) => Promise<string>
  now: () => Date
}

const DEFAULT_DEPENDENCIES: SmartAppVerifierDependencies = {
  validatePackage: validateSmartAppPackageDirectory,
  parseContract: parseSmartAppVerificationContract,
  runScripts: runSmartAppProjectScripts,
  validateArtifacts: validateSmartAppArtifacts,
  verifyRuntime: verifySmartAppRuntime,
  fingerprint: fingerprintSmartAppDirectory,
  now: () => new Date(),
}

export class SmartAppVerifier {
  private readonly inFlight = new Map<string, Promise<SmartAppVerificationReport>>()

  constructor(
    private readonly options: SmartAppVerifierOptions,
    private readonly dependencies: SmartAppVerifierDependencies = DEFAULT_DEPENDENCIES
  ) {}

  async verify(projectRoot: string): Promise<SmartAppVerificationReport> {
    const root = await requiredSmartAppDirectory(projectRoot, 'Smart app project')
    const current = this.inFlight.get(root)
    if (current) return current
    const verification = this.runVerification(root).finally(() => {
      if (this.inFlight.get(root) === verification) this.inFlight.delete(root)
    })
    this.inFlight.set(root, verification)
    return verification
  }

  async inspect(projectRoot: string): Promise<SmartAppVerificationReport | null> {
    const root = await requiredSmartAppDirectory(projectRoot, 'Smart app project')
    let persisted: SmartAppVerificationReport
    try {
      persisted = JSON.parse(await readFile(join(root, REPORT_PATH), 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return null
    }
    if (!isVerificationReport(persisted)) return null
    const currentFingerprint = await this.dependencies
      .fingerprint(root, 'verification-input')
      .catch(() => null)
    return {
      ...persisted,
      projectRoot: root,
      status:
        currentFingerprint === persisted.inputFingerprint ? persisted.status : ('stale' as const),
    }
  }

  private async runVerification(root: string): Promise<SmartAppVerificationReport> {
    const startedAt = this.dependencies.now().toISOString()
    let inputFingerprint: string
    try {
      inputFingerprint = await this.dependencies.fingerprint(root, 'verification-input')
    } catch (error) {
      return this.finishEnvironmentFailure(root, startedAt, error)
    }

    const stages: SmartAppVerificationStageResult[] = []
    const issues: SmartAppVerificationIssue[] = []
    let manifest: WorkbenchAppManifest | null = null
    let contract: SmartAppVerificationContract | null = null
    let deliverableFingerprint: string | null = null

    const manifestStartedAt = this.dependencies.now().toISOString()
    try {
      const validated = await this.dependencies.validatePackage(root)
      manifest = validated.manifest
      const packageScripts = await readPackageScripts(root)
      const source = await optionalFile(join(root, 'smart-app.verify.json'))
      const parsed = this.dependencies.parseContract(source, {
        manifestProfile: manifest.entry.profile,
        packageScripts,
      })
      contract = parsed.contract
      issues.push(...parsed.issues)
    } catch (error) {
      issues.push(issueFromError(error, 'manifest'))
    }
    stages.push(stageResult('manifest', manifestStartedAt, this.dependencies.now(), issues))
    if (!manifest || !contract || hasBlockingIssues(issues)) {
      appendSkippedStages(stages, 'scripts', this.dependencies.now)
      return this.finish(root, startedAt, inputFingerprint, deliverableFingerprint, stages, issues)
    }

    const scriptsStartedAt = this.dependencies.now().toISOString()
    let scripts: SmartAppProjectScriptsResult
    try {
      scripts = await this.dependencies.runScripts({
        projectRoot: root,
        runtimeRoot: this.options.runtimeRoot,
        environment: this.options.environment,
        scripts: contract.scripts,
      })
    } catch (error) {
      scripts = { scripts: [], issues: [environmentIssue('SA-ENV-SCRIPTS', error)] }
    }
    issues.push(...scripts.issues)
    stages.push(
      stageResult(
        'scripts',
        scriptsStartedAt,
        this.dependencies.now(),
        scripts.issues,
        scripts.scripts.at(-1)?.logPath ?? null
      )
    )
    if (hasBlockingIssues(scripts.issues)) {
      appendSkippedStages(stages, 'artifacts', this.dependencies.now)
      return this.finish(root, startedAt, inputFingerprint, deliverableFingerprint, stages, issues)
    }

    const artifactsStartedAt = this.dependencies.now().toISOString()
    let artifacts: SmartAppArtifactValidationResult
    try {
      deliverableFingerprint = await this.dependencies.fingerprint(root, 'deliverable')
      artifacts = await this.dependencies.validateArtifacts({
        projectRoot: root,
        manifest,
        contract,
      })
    } catch (error) {
      artifacts = { issues: [environmentIssue('SA-ENV-ARTIFACTS', error)] }
    }
    issues.push(...artifacts.issues)
    stages.push(
      stageResult('artifacts', artifactsStartedAt, this.dependencies.now(), artifacts.issues)
    )
    if (hasBlockingIssues(artifacts.issues)) {
      appendSkippedStages(stages, 'runtime', this.dependencies.now)
      return this.finish(root, startedAt, inputFingerprint, deliverableFingerprint, stages, issues)
    }

    const runtimeStartedAt = this.dependencies.now().toISOString()
    let runtime: { issues: SmartAppVerificationIssue[] }
    try {
      runtime = await this.dependencies.verifyRuntime({
        projectRoot: root,
        runtimeRoot: this.options.runtimeRoot,
        logDirectory: join(root, 'test-results', 'smart-app', 'logs'),
        environment: this.options.environment,
        manifest,
        contract,
      })
    } catch (error) {
      runtime = { issues: [environmentIssue('SA-ENV-RUNTIME', error)] }
    }
    issues.push(...runtime.issues)
    stages.push(stageResult('runtime', runtimeStartedAt, this.dependencies.now(), runtime.issues))
    return this.finish(root, startedAt, inputFingerprint, deliverableFingerprint, stages, issues)
  }

  private async finishEnvironmentFailure(
    root: string,
    startedAt: string,
    error: unknown
  ): Promise<SmartAppVerificationReport> {
    const issue = issueFromError(error, 'environment')
    const now = this.dependencies.now()
    const stages: SmartAppVerificationStageResult[] = [
      stageResult('environment', startedAt, now, [issue]),
    ]
    appendSkippedStages(stages, 'manifest', this.dependencies.now)
    return this.finish(root, startedAt, '', null, stages, [issue])
  }

  private async finish(
    root: string,
    startedAt: string,
    inputFingerprint: string,
    deliverableFingerprint: string | null,
    stages: SmartAppVerificationStageResult[],
    issues: SmartAppVerificationIssue[]
  ): Promise<SmartAppVerificationReport> {
    const report: SmartAppVerificationReport = {
      schemaVersion: 1,
      status: issues.length === 0 ? 'passed' : 'failed',
      projectRoot: root,
      inputFingerprint,
      deliverableFingerprint,
      startedAt,
      finishedAt: this.dependencies.now().toISOString(),
      stages,
      issues,
    }
    await persistReport(root, report)
    return report
  }
}

async function readPackageScripts(root: string): Promise<Record<string, string>> {
  const value: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (!record(value) || !record(value.scripts)) return {}
  return Object.fromEntries(
    Object.entries(value.scripts).filter((entry): entry is [string, string] => {
      return typeof entry[1] === 'string'
    })
  )
}

async function optionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function persistReport(root: string, report: SmartAppVerificationReport): Promise<void> {
  const path = join(root, REPORT_PATH)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify({ ...report, projectRoot: '.' }, null, 2)}\n`, {
      mode: 0o600,
    })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

function appendSkippedStages(
  stages: SmartAppVerificationStageResult[],
  from: (typeof PIPELINE_STAGES)[number],
  now: () => Date
): void {
  const first = PIPELINE_STAGES.indexOf(from)
  for (const stage of PIPELINE_STAGES.slice(first)) {
    const timestamp = now().toISOString()
    stages.push({
      stage,
      status: 'skipped',
      startedAt: timestamp,
      finishedAt: timestamp,
      logPath: null,
    })
  }
}

function stageResult(
  stage: SmartAppVerificationStage,
  startedAt: string,
  finishedAt: Date,
  issues: SmartAppVerificationIssue[],
  logPath: string | null = null
): SmartAppVerificationStageResult {
  return {
    stage,
    status: issues.length ? 'failed' : 'passed',
    startedAt,
    finishedAt: finishedAt.toISOString(),
    logPath,
  }
}

function hasBlockingIssues(issues: SmartAppVerificationIssue[]): boolean {
  return issues.some(issue => issue.blocking)
}

function issueFromError(
  error: unknown,
  stage: SmartAppVerificationStage
): SmartAppVerificationIssue {
  if (error instanceof SmartAppPackageValidationError) return error.issue
  return {
    code: stage === 'environment' ? 'SA-ENV-FINGERPRINT' : 'SA-MANIFEST-READ',
    stage,
    file: null,
    message:
      stage === 'environment'
        ? 'Smart App inputs could not be read'
        : 'Smart App manifest could not be read',
    expected: null,
    actual: error instanceof Error ? error.name : typeof error,
    blocking: true,
    hint: null,
  }
}

function environmentIssue(code: string, error: unknown): SmartAppVerificationIssue {
  return {
    code,
    stage: 'environment',
    file: null,
    message: 'The Smart App verification environment is unavailable',
    expected: null,
    actual: error instanceof Error ? error.name : typeof error,
    blocking: true,
    hint: null,
  }
}

function isVerificationReport(value: unknown): value is SmartAppVerificationReport {
  if (!record(value)) return false
  return (
    value.schemaVersion === 1 &&
    (value.status === 'passed' || value.status === 'failed' || value.status === 'stale') &&
    typeof value.inputFingerprint === 'string' &&
    Array.isArray(value.stages) &&
    Array.isArray(value.issues)
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
