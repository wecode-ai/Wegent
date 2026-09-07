import type {
  SmartAppVerificationCapabilities,
  SmartAppVerificationContract,
  SmartAppVerificationIssue,
  SmartAppVerificationRuntime,
  SmartAppVerificationScripts,
} from './smart-app-verification-types.js'

const CONTRACT_PATH = 'smart-app.verify.json'
const SCRIPT_NAME = /^[A-Za-z0-9:_-]+$/
const MAX_READY_SELECTOR_LENGTH = 512

export interface SmartAppVerificationContractContext {
  manifestProfile: string
  packageScripts: Record<string, string>
}

export interface SmartAppVerificationContractResult {
  contract: SmartAppVerificationContract | null
  issues: SmartAppVerificationIssue[]
}

export function parseSmartAppVerificationContract(
  source: string | null,
  context: SmartAppVerificationContractContext
): SmartAppVerificationContractResult {
  if (source === null) {
    return failure('SA-MANIFEST-CONTRACT-MISSING', 'Smart App verification contract is missing')
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    return failure('SA-MANIFEST-CONTRACT-JSON', 'Smart App verification contract is not valid JSON')
  }
  const parsed = asRecord(value)
  if (!parsed) {
    return failure(
      'SA-MANIFEST-CONTRACT-SHAPE',
      'Smart App verification contract must be an object'
    )
  }
  const issues: SmartAppVerificationIssue[] = []
  rejectUnknownFields(parsed, ['schemaVersion', 'scripts', 'capabilities', 'runtime'], '', issues)
  if (parsed.schemaVersion !== 1) {
    issues.push(
      issue(
        'SA-MANIFEST-CONTRACT-SCHEMA',
        'Smart App verification contract schema is not supported',
        '1',
        describe(parsed.schemaVersion)
      )
    )
  }
  const scripts = readScripts(parsed.scripts, context.packageScripts, issues)
  const capabilities = readCapabilities(parsed.capabilities, issues)
  const runtime = readRuntime(parsed.runtime, context.manifestProfile, issues)
  if (capabilities.remote && (!capabilities.host || !capabilities.client)) {
    issues.push(
      issue(
        'SA-MANIFEST-CONTRACT-REMOTE-CAPABILITIES',
        'Remote verification requires both Host and Client capabilities'
      )
    )
  }
  if (capabilities.remote && !scripts.runtimeProbe) {
    issues.push(
      issue(
        'SA-MANIFEST-CONTRACT-REMOTE-PROBE',
        'Remote verification requires a runtimeProbe package script'
      )
    )
  }
  return {
    contract: issues.length === 0 ? { schemaVersion: 1, scripts, capabilities, runtime } : null,
    issues,
  }
}

function readScripts(
  value: unknown,
  packageScripts: Record<string, string>,
  issues: SmartAppVerificationIssue[]
): SmartAppVerificationScripts {
  const record = asRecord(value)
  if (!record) {
    issues.push(issue('SA-MANIFEST-CONTRACT-SCRIPTS', 'scripts must be an object'))
  }
  const scripts = record ?? {}
  rejectUnknownFields(scripts, ['typecheck', 'test', 'build', 'runtimeProbe'], 'scripts', issues)
  return {
    typecheck: readScript('typecheck', scripts.typecheck, packageScripts, issues),
    test: readScript('test', scripts.test, packageScripts, issues),
    build: readScript('build', scripts.build, packageScripts, issues),
    ...optionalRuntimeProbe(scripts.runtimeProbe, packageScripts, issues),
  }
}

function readScript(
  field: string,
  value: unknown,
  packageScripts: Record<string, string>,
  issues: SmartAppVerificationIssue[]
): string {
  if (typeof value !== 'string' || !SCRIPT_NAME.test(value)) {
    issues.push(
      issue(
        'SA-MANIFEST-CONTRACT-SCRIPT-NAME',
        `scripts.${field} must name one package script`,
        'A-Za-z0-9:_-',
        describe(value)
      )
    )
    return ''
  }
  if (!Object.hasOwn(packageScripts, value)) {
    issues.push(
      issue(
        'SA-MANIFEST-CONTRACT-SCRIPT-MISSING',
        `Package script ${value} does not exist`,
        value,
        null
      )
    )
  }
  return value
}

function optionalRuntimeProbe(
  value: unknown,
  packageScripts: Record<string, string>,
  issues: SmartAppVerificationIssue[]
): Pick<SmartAppVerificationScripts, 'runtimeProbe'> {
  if (value === undefined) return {}
  return { runtimeProbe: readScript('runtimeProbe', value, packageScripts, issues) }
}

function readCapabilities(
  value: unknown,
  issues: SmartAppVerificationIssue[]
): SmartAppVerificationCapabilities {
  const record = asRecord(value)
  if (!record) {
    issues.push(issue('SA-MANIFEST-CONTRACT-CAPABILITIES', 'capabilities must be an object'))
  }
  const capabilities = record ?? {}
  rejectUnknownFields(capabilities, ['host', 'client', 'remote'], 'capabilities', issues)
  return {
    host: readBoolean('host', capabilities.host, issues),
    client: readBoolean('client', capabilities.client, issues),
    remote: readBoolean('remote', capabilities.remote, issues),
  }
}

function readBoolean(field: string, value: unknown, issues: SmartAppVerificationIssue[]): boolean {
  if (typeof value === 'boolean') return value
  issues.push(
    issue(
      'SA-MANIFEST-CONTRACT-CAPABILITY',
      `capabilities.${field} must be a boolean`,
      'boolean',
      describe(value)
    )
  )
  return false
}

function readRuntime(
  value: unknown,
  manifestProfile: string,
  issues: SmartAppVerificationIssue[]
): SmartAppVerificationRuntime {
  const record = asRecord(value)
  if (!record) issues.push(issue('SA-MANIFEST-CONTRACT-RUNTIME', 'runtime must be an object'))
  const runtime = record ?? {}
  rejectUnknownFields(runtime, ['profile', 'path', 'readySelector'], 'runtime', issues)
  const profile = text(runtime.profile)
  const path = text(runtime.path)
  const readySelector = text(runtime.readySelector)
  if (profile !== manifestProfile) {
    issues.push(
      issue(
        'SA-MANIFEST-CONTRACT-PROFILE',
        'Verification profile must match the Smart App manifest',
        manifestProfile,
        profile || null
      )
    )
  }
  if (!safeRuntimePath(path)) {
    issues.push(
      issue('SA-MANIFEST-CONTRACT-PATH', 'Runtime path must stay on the Smart App origin')
    )
  }
  if (!readySelector || readySelector.length > MAX_READY_SELECTOR_LENGTH) {
    issues.push(
      issue(
        'SA-MANIFEST-CONTRACT-SELECTOR',
        'Runtime readySelector must contain 1 to 512 characters'
      )
    )
  }
  return { profile, path, readySelector }
}

function safeRuntimePath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false
  try {
    return !decodeURIComponent(value).split('/').includes('..')
  } catch {
    return false
  }
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: string[],
  prefix: string,
  issues: SmartAppVerificationIssue[]
): void {
  for (const field of Object.keys(record)) {
    if (allowed.includes(field)) continue
    const path = prefix ? `${prefix}.${field}` : field
    issues.push(
      issue('SA-MANIFEST-CONTRACT-UNKNOWN-FIELD', `Unknown verification contract field: ${path}`)
    )
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function failure(code: string, message: string): SmartAppVerificationContractResult {
  return { contract: null, issues: [issue(code, message)] }
}

function issue(
  code: string,
  message: string,
  expected: string | null = null,
  actual: string | null = null
): SmartAppVerificationIssue {
  return {
    code,
    stage: 'manifest',
    file: CONTRACT_PATH,
    message,
    expected,
    actual,
    blocking: true,
    hint: null,
  }
}

function describe(value: unknown): string | null {
  if (value === undefined) return null
  if (value === null) return 'null'
  return typeof value
}
