export type SmartAppVerificationStage =
  | 'environment'
  | 'manifest'
  | 'scripts'
  | 'artifacts'
  | 'runtime'
  | 'package'

export interface SmartAppVerificationIssue {
  code: string
  stage: SmartAppVerificationStage
  file: string | null
  message: string
  expected: string | null
  actual: string | null
  blocking: boolean
  hint: string | null
}

export interface SmartAppVerificationScripts {
  typecheck: string
  test: string
  build: string
  runtimeProbe?: string
}

export interface SmartAppVerificationCapabilities {
  host: boolean
  client: boolean
  remote: boolean
}

export interface SmartAppVerificationRuntime {
  profile: string
  path: string
  readySelector: string
}

export interface SmartAppVerificationContract {
  schemaVersion: 1
  scripts: SmartAppVerificationScripts
  capabilities: SmartAppVerificationCapabilities
  runtime: SmartAppVerificationRuntime
}

export interface SmartAppVerificationStageResult {
  stage: SmartAppVerificationStage
  status: 'passed' | 'failed' | 'skipped'
  startedAt: string
  finishedAt: string
  logPath: string | null
}

export interface SmartAppVerificationReport {
  schemaVersion: 1
  status: 'passed' | 'failed' | 'stale'
  projectRoot: string
  inputFingerprint: string
  deliverableFingerprint: string | null
  startedAt: string
  finishedAt: string
  stages: SmartAppVerificationStageResult[]
  issues: SmartAppVerificationIssue[]
}
