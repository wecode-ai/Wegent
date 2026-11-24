import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HostCapabilityError } from './capability-router.js'
import {
  ConnectionHttpError,
  type ConnectionCsrfBinding,
  type ConnectionHttpOperation,
} from './connection-http.js'

export interface WebConnectionScope {
  origin: string
  pathPrefix?: string
  name: string
  account: string
  operations: Array<
    Pick<ConnectionHttpOperation, 'method' | 'path'> & { csrf?: ConnectionCsrfBinding }
  >
}

interface Binding {
  providerId: string
  definitionDigest: string
}

interface Trial {
  scope: WebConnectionScope
  binding: Binding
  expires: number
}

const FILES = ['connection.json', 'cordis.patch.yml', 'index.js', 'package.json'] as const

function denied(message: string): never {
  throw new HostCapabilityError('web_connection_denied', message)
}

function bindingKey(binding: Binding): string {
  if (
    !/^wework-web-[a-z0-9]+(?:-[a-z0-9]+)*\/web$/.test(binding.providerId) ||
    binding.providerId.length > 120 ||
    !/^[a-f0-9]{64}$/.test(binding.definitionDigest)
  )
    denied('Invalid web connection identity')
  return createHash('sha256')
    .update(JSON.stringify([binding.providerId, binding.definitionDigest]))
    .digest('hex')
}

function matchingPage(scope: WebConnectionScope, value: string | null): boolean {
  const page = value ? URL.parse(value) : null
  return Boolean(
    page &&
    page.origin === scope.origin &&
    (!scope.pathPrefix ||
      page.pathname === scope.pathPrefix ||
      page.pathname.startsWith(scope.pathPrefix + '/'))
  )
}

export class WebConnectionGrants {
  private readonly trials = new Map<string, Trial>()

  constructor(
    private readonly root: string,
    private readonly currentPage: (label: string) => string | null,
    private readonly confirm: (scope: WebConnectionScope) => Promise<boolean>,
    private readonly request: (
      origin: string,
      operation: ConnectionHttpOperation,
      csrf?: ConnectionCsrfBinding
    ) => Promise<unknown>
  ) {}

  async approveTrial(label: string, binding: Binding, scope: WebConnectionScope): Promise<string> {
    bindingKey(binding)
    const origin = URL.parse(scope.origin)
    if (
      !origin ||
      !['https:', 'http:'].includes(origin.protocol) ||
      origin.origin !== scope.origin ||
      !scope.name?.trim() ||
      scope.name.length > 160 ||
      !scope.account?.trim() ||
      scope.account.length > 256 ||
      !Array.isArray(scope.operations) ||
      !scope.operations.length ||
      scope.operations.length > 32 ||
      scope.operations.some(
        operation =>
          !['GET', 'POST'].includes(operation.method) ||
          typeof operation.path !== 'string' ||
          !operation.path.startsWith('/') ||
          operation.path.length > 512 ||
          /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(operation.path) ||
          Array.from(operation.path).some(character => character.charCodeAt(0) < 32)
      ) ||
      !matchingPage(scope, this.currentPage(label))
    )
      denied('Open the source page before approving the trial')
    if (!(await this.confirm(scope))) {
      throw new HostCapabilityError('web_connection_trial_cancelled', 'The trial was cancelled')
    }
    if (!matchingPage(scope, this.currentPage(label))) denied('The source page changed')
    for (const [id, trial] of this.trials) {
      if (trial.expires <= Date.now()) this.trials.delete(id)
    }
    const id = randomUUID()
    this.trials.set(id, { scope, binding, expires: Date.now() + 10 * 60_000 })
    return id
  }

  private trial(id: string, binding: Binding): Trial {
    const trial = this.trials.get(id)
    if (!trial || trial.expires <= Date.now()) {
      this.trials.delete(id)
      throw new HostCapabilityError(
        'web_connection_trial_required',
        'The trial approval has expired'
      )
    }
    if (bindingKey(trial.binding) !== bindingKey(binding))
      denied('This approval belongs to a different connection')
    return trial
  }

  async read(binding: Binding, operation: ConnectionHttpOperation, trialId?: string) {
    const key = bindingKey(binding)
    const scope = trialId
      ? this.trial(trialId, binding).scope
      : await this.readApproved(join(this.root, key, 'grant.json'))
    const approved = scope.operations.find(
      candidate => candidate.method === operation.method && candidate.path === operation.path
    )
    if (!approved) denied('This request is outside the approved web connection')
    try {
      return await this.request(scope.origin, operation, approved.csrf)
    } catch (error) {
      if (error instanceof ConnectionHttpError)
        throw new HostCapabilityError(error.code, error.message)
      throw new HostCapabilityError('connection_http_failed', 'The site request failed')
    }
  }

  private async readApproved(path: string): Promise<WebConnectionScope> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as WebConnectionScope
    } catch {
      denied('This device has no approval for the connection version')
    }
  }

  async install(
    binding: Binding,
    trialId: string,
    files: Record<string, string>,
    installPlugin: (spec: string) => Promise<unknown>
  ) {
    const trial = this.trial(trialId, binding)
    if (
      FILES.some(name => typeof files[name] !== 'string' || Buffer.byteLength(files[name]) > 262144)
    )
      denied('The generated package has invalid files')
    const contentDigest = createHash('sha256').update(files['connection.json']).digest('hex')
    if (contentDigest !== binding.definitionDigest) denied('The trial definition has changed')
    const key = bindingKey(binding)
    const directory = join(this.root, key)
    const staging = join(this.root, randomUUID())
    await mkdir(staging, { recursive: true, mode: 0o700 })
    try {
      const pkg = join(staging, 'plugin')
      await mkdir(pkg)
      await Promise.all(FILES.map(name => writeFile(join(pkg, name), files[name], { flag: 'wx' })))
      await writeFile(join(staging, 'grant.json'), JSON.stringify(trial.scope), { flag: 'wx' })
      await rename(staging, directory)
      try {
        await installPlugin(`file:${join(directory, 'plugin')}`)
      } catch (error) {
        await rm(directory, { recursive: true, force: true })
        throw error
      }
      this.trials.delete(trialId)
      return { providerId: binding.providerId }
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
}
