import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import {
  validateSmartAppArtifacts,
  type SmartAppArtifactValidationResult,
  type ValidateSmartAppArtifactsOptions,
} from './smart-app-artifact-validator.js'
import {
  archiveSmartAppDelivery,
  extractSmartAppArchive,
  findSmartAppManifestRoot,
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

export interface SmartAppPackResult {
  archivePath: string
  sha256: string
  sizeBytes: number
  manifest: WorkbenchAppManifest
  report: SmartAppVerificationReport
}

export interface SmartAppVerifierPackageDependencies {
  archiveDelivery: (projectRoot: string, archivePath: string) => Promise<void>
  extractArchive: (archivePath: string, destination: string) => Promise<void>
  findManifestRoot: (root: string) => Promise<string>
  validateArchivePackage: (projectRoot: string) => Promise<ValidatedSmartAppPackage>
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
  validatePackage: projectRoot =>
    validateSmartAppPackageDirectory(projectRoot, { developmentSource: true }),
  parseContract: parseSmartAppVerificationContract,
  runScripts: runSmartAppProjectScripts,
  validateArtifacts: validateSmartAppArtifacts,
  verifyRuntime: verifySmartAppRuntime,
  fingerprint: fingerprintSmartAppDirectory,
  now: () => new Date(),
}

const DEFAULT_PACKAGE_DEPENDENCIES: SmartAppVerifierPackageDependencies = {
  archiveDelivery: archiveSmartAppDelivery,
  extractArchive: extractSmartAppArchive,
  findManifestRoot: findSmartAppManifestRoot,
  validateArchivePackage: validateSmartAppPackageDirectory,
}

export class SmartAppVerificationError extends Error {
  constructor(readonly report: SmartAppVerificationReport) {
    super(report.issues[0]?.code ?? 'Smart App verification failed')
    this.name = 'SmartAppVerificationError'
  }
}

export class SmartAppVerifier {
  private readonly inFlight = new Map<string, Promise<SmartAppVerificationReport>>()
  private readonly packageDependencies: SmartAppVerifierPackageDependencies

  constructor(
    private readonly options: SmartAppVerifierOptions,
    private readonly dependencies: SmartAppVerifierDependencies = DEFAULT_DEPENDENCIES,
    packageDependencies: Partial<SmartAppVerifierPackageDependencies> = {}
  ) {
    this.packageDependencies = { ...DEFAULT_PACKAGE_DEPENDENCIES, ...packageDependencies }
  }

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

  async pack(projectRoot: string, archivePath: string): Promise<SmartAppPackResult> {
    const root = await requiredSmartAppDirectory(projectRoot, 'Smart app project')
    const destination = resolve(archivePath)
    const previousReport = await this.inspect(root)
    if (!previousReport) {
      throw new SmartAppVerificationError(await this.unverifiedPackageReport(root))
    }
    if (previousReport.status === 'stale') {
      throw new SmartAppVerificationError(stalePackageReport(previousReport))
    }
    if (previousReport.status !== 'passed') {
      throw new SmartAppVerificationError(previousReport)
    }
    const sourceReport = await this.verify(root)
    if (sourceReport.status !== 'passed') throw new SmartAppVerificationError(sourceReport)
    const packageStartedAt = this.dependencies.now().toISOString()
    const snapshot = await this.readVerifiedSnapshot(root, sourceReport)
    if (snapshot.issues.length || !snapshot.manifest || !snapshot.contract) {
      const report = await this.finishPackageReport(
        root,
        sourceReport,
        packageStartedAt,
        snapshot.issues
      )
      throw new SmartAppVerificationError(report)
    }
    const temporaryArchive = join(
      dirname(destination),
      `.${basename(destination)}.${randomUUID()}.tmp`
    )
    const extractedRoot = await mkdtemp(join(tmpdir(), 'wework-smart-app-package-'))
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    try {
      const issues = await this.verifyDeliveryArchive({
        root,
        temporaryArchive,
        extractedRoot,
        sourceReport,
        contract: snapshot.contract,
      })
      const report = await this.finishPackageReport(root, sourceReport, packageStartedAt, issues)
      if (issues.length) throw new SmartAppVerificationError(report)
      const metadata = await stat(temporaryArchive)
      const sha256 = await fileSha256(temporaryArchive)
      await rename(temporaryArchive, destination)
      return {
        archivePath: destination,
        sha256,
        sizeBytes: metadata.size,
        manifest: snapshot.manifest,
        report,
      }
    } finally {
      await rm(temporaryArchive, { force: true })
      await rm(extractedRoot, { recursive: true, force: true })
    }
  }

  private async unverifiedPackageReport(root: string): Promise<SmartAppVerificationReport> {
    const timestamp = this.dependencies.now().toISOString()
    const issue = unverifiedPackageIssue()
    return {
      schemaVersion: 1,
      status: 'failed',
      projectRoot: root,
      inputFingerprint: await this.dependencies
        .fingerprint(root, 'verification-input')
        .catch(() => ''),
      deliverableFingerprint: null,
      startedAt: timestamp,
      finishedAt: timestamp,
      stages: [stageResult('package', timestamp, new Date(timestamp), [issue])],
      issues: [issue],
    }
  }

  private async readVerifiedSnapshot(
    root: string,
    report: SmartAppVerificationReport
  ): Promise<{
    manifest: WorkbenchAppManifest | null
    contract: SmartAppVerificationContract | null
    issues: SmartAppVerificationIssue[]
  }> {
    try {
      const current = await this.dependencies.fingerprint(root, 'verification-input')
      if (current !== report.inputFingerprint) {
        return { manifest: null, contract: null, issues: [stalePackageIssue()] }
      }
      const validated = await this.dependencies.validatePackage(root)
      const parsed = this.dependencies.parseContract(
        await optionalFile(join(root, 'smart-app.verify.json')),
        {
          manifestProfile: validated.manifest.entry.profile,
          packageScripts: await readPackageScripts(root),
        }
      )
      return {
        manifest: parsed.contract ? validated.manifest : null,
        contract: parsed.contract,
        issues: parsed.issues,
      }
    } catch (error) {
      return { manifest: null, contract: null, issues: [packageIssueFromError(error)] }
    }
  }

  private async verifyDeliveryArchive(options: {
    root: string
    temporaryArchive: string
    extractedRoot: string
    sourceReport: SmartAppVerificationReport
    contract: SmartAppVerificationContract
  }): Promise<SmartAppVerificationIssue[]> {
    try {
      await this.packageDependencies.archiveDelivery(options.root, options.temporaryArchive)
      const current = await this.dependencies.fingerprint(options.root, 'verification-input')
      if (current !== options.sourceReport.inputFingerprint) return [stalePackageIssue()]
      await this.packageDependencies.extractArchive(options.temporaryArchive, options.extractedRoot)
      const packageRoot = await this.packageDependencies.findManifestRoot(options.extractedRoot)
      const validated = await this.packageDependencies.validateArchivePackage(packageRoot)
      const artifacts = await this.dependencies.validateArtifacts({
        projectRoot: packageRoot,
        manifest: validated.manifest,
        contract: options.contract,
      })
      if (hasBlockingIssues(artifacts.issues)) return artifacts.issues
      const delivered = await this.dependencies.fingerprint(packageRoot, 'deliverable')
      if (delivered !== options.sourceReport.deliverableFingerprint) {
        return [deliveryMismatchIssue()]
      }
      const runtime = await this.dependencies.verifyRuntime({
        projectRoot: packageRoot,
        runtimeRoot: this.options.runtimeRoot,
        logDirectory: join(options.root, 'test-results', 'smart-app', 'logs', 'package'),
        environment: this.options.environment,
        manifest: validated.manifest,
        contract: options.contract,
      })
      return [...artifacts.issues, ...runtime.issues]
    } catch (error) {
      return [packageIssueFromError(error)]
    }
  }

  private async finishPackageReport(
    root: string,
    source: SmartAppVerificationReport,
    startedAt: string,
    issues: SmartAppVerificationIssue[]
  ): Promise<SmartAppVerificationReport> {
    const finishedAt = this.dependencies.now()
    const report: SmartAppVerificationReport = {
      ...source,
      status: issues.length ? 'failed' : 'passed',
      projectRoot: root,
      finishedAt: finishedAt.toISOString(),
      stages: [
        ...source.stages.filter(stage => stage.stage !== 'package'),
        stageResult('package', startedAt, finishedAt, issues),
      ],
      issues: [...source.issues, ...issues],
    }
    await persistReport(root, report)
    return report
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

function packageIssueFromError(error: unknown): SmartAppVerificationIssue {
  if (error instanceof SmartAppPackageValidationError) return error.issue
  return {
    code: 'SA-PACKAGE-VERIFY',
    stage: 'package',
    file: null,
    message: 'Smart App delivery archive verification failed',
    expected: null,
    actual: error instanceof Error ? error.name : typeof error,
    blocking: true,
    hint: null,
  }
}

function stalePackageIssue(): SmartAppVerificationIssue {
  return {
    code: 'SA-PACKAGE-STALE',
    stage: 'package',
    file: null,
    message: 'Smart App inputs changed after verification',
    expected: 'Verified source inputs',
    actual: 'Changed source inputs',
    blocking: true,
    hint: 'Run verification again',
  }
}

function unverifiedPackageIssue(): SmartAppVerificationIssue {
  return {
    code: 'SA-PACKAGE-UNVERIFIED',
    stage: 'package',
    file: null,
    message: 'Smart App has no current passing verification report',
    expected: 'A current passing report',
    actual: 'No report',
    blocking: true,
    hint: 'Run verification before packaging',
  }
}

function stalePackageReport(report: SmartAppVerificationReport): SmartAppVerificationReport {
  const issue = stalePackageIssue()
  return {
    ...report,
    status: 'stale',
    stages: [
      ...report.stages.filter(stage => stage.stage !== 'package'),
      {
        stage: 'package',
        status: 'failed',
        startedAt: report.finishedAt,
        finishedAt: report.finishedAt,
        logPath: null,
      },
    ],
    issues: [...report.issues, issue],
  }
}

function deliveryMismatchIssue(): SmartAppVerificationIssue {
  return {
    code: 'SA-PACKAGE-CONTENT',
    stage: 'package',
    file: null,
    message: 'Smart App delivery archive does not match the verified build',
    expected: 'Verified deliverable fingerprint',
    actual: 'Different deliverable fingerprint',
    blocking: true,
    hint: null,
  }
}

async function fileSha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
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
