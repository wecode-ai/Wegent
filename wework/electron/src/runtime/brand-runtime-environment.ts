import { join } from 'node:path'

export interface BrandRuntimeMetadata {
  weworkBackendUrl?: string
  weworkExecutorNamespace?: string
  weworkSocketUrl?: string
}

const BACKEND_ENVIRONMENT_KEYS = [
  'WEWORK_BACKEND_URL',
  'WEGENT_BACKEND_URL',
  'VITE_WEGENT_BACKEND_URL',
] as const
const SOCKET_ENVIRONMENT_KEYS = [
  'WEWORK_SOCKET_URL',
  'WEGENT_SOCKET_URL',
  'VITE_WEGENT_SOCKET_URL',
] as const

export function applyBrandRuntimeEnvironment(
  environment: NodeJS.ProcessEnv,
  metadata: BrandRuntimeMetadata,
  homeDirectory: string
): NodeJS.ProcessEnv {
  const resolved = { ...environment }
  const executorNamespace = metadata.weworkExecutorNamespace?.trim()
  if (!resolved.WEGENT_EXECUTOR_HOME?.trim() && executorNamespace) {
    resolved.WEGENT_EXECUTOR_HOME = join(homeDirectory, '.wework', 'apps', executorNamespace)
  }

  const backendUrl = metadata.weworkBackendUrl?.trim()
  if (!hasConfiguredValue(resolved, BACKEND_ENVIRONMENT_KEYS) && backendUrl) {
    resolved.WEWORK_BACKEND_URL = backendUrl
  }

  const socketUrl = metadata.weworkSocketUrl?.trim()
  if (!hasConfiguredValue(resolved, SOCKET_ENVIRONMENT_KEYS) && socketUrl) {
    resolved.WEWORK_SOCKET_URL = socketUrl
  }
  return resolved
}

function hasConfiguredValue(environment: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  return keys.some(key => environment[key]?.trim())
}
