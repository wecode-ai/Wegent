import { createHash } from 'node:crypto'
import type { APIRequestContext } from '@playwright/test'
import type { TestUser } from '../config/test-users'
import { scopedMockUrl } from './mock-scope'

export function executorWorkerScope(
  env: Partial<Record<string, string | undefined>>,
  workerIndex: number
): string {
  const run = env.GITHUB_RUN_ID || env.E2E_USER_SUFFIX || 'local'
  const attempt = env.GITHUB_RUN_ATTEMPT || '1'
  return `executor-${createHash('sha256').update(`${run}:${attempt}:${workerIndex}`).digest('hex').slice(0, 24)}`
}

const requests = new WeakMap<APIRequestContext, { scope: string; user: TestUser }>()

export function bindExecutorRequest(
  request: APIRequestContext,
  scope: string,
  user: TestUser
): void {
  requests.set(request, { scope, user })
}

export function executorRequestUser(request: APIRequestContext, defaultUser: TestUser): TestUser {
  return requests.get(request)?.user || defaultUser
}

export function executorRequestMockUrl(request: APIRequestContext, base: string): string {
  const context = requests.get(request)
  return context ? scopedMockUrl(base, context.scope) : base
}
