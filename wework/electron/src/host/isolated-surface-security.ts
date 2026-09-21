import { existsSync, readFileSync } from 'node:fs'
import { resolveDshAppRoute } from './dsh-app-route.js'

export interface TrustedIsolatedSurfacePolicy {
  path: string
  partitionPrefix: string
  identityParameter: string
  modeParameter: string
  modeValue: string
}

export function loadTrustedIsolatedSurfacePolicies(path: string): TrustedIsolatedSurfacePolicy[] {
  if (!existsSync(path)) return []
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(value)) throw new Error('Invalid isolated surface policy manifest')
  return value.map(candidate => {
    if (!candidate || typeof candidate !== 'object') {
      throw new Error('Invalid isolated surface policy')
    }
    const policy = candidate as Record<string, unknown>
    const fields = ['path', 'partitionPrefix', 'identityParameter', 'modeParameter', 'modeValue']
    if (fields.some(field => typeof policy[field] !== 'string' || !policy[field])) {
      throw new Error('Invalid isolated surface policy')
    }
    if (!/^\/[a-z0-9/-]+$/.test(policy.path as string)) {
      throw new Error('Invalid isolated surface path')
    }
    return policy as unknown as TrustedIsolatedSurfacePolicy
  })
}

export function isTrustedIsolatedSurfaceAttachment(
  params: Record<string, unknown>,
  dshUrl: string,
  policies: readonly TrustedIsolatedSurfacePolicy[]
): boolean {
  if (typeof params.partition !== 'string' || typeof params.src !== 'string') return false
  let target: URL
  try {
    target = new URL(params.src)
  } catch {
    return false
  }
  if (
    target.origin !== new URL(dshUrl).origin ||
    target.username ||
    target.password ||
    target.hash
  ) {
    return false
  }
  return policies.some(policy => matchesPolicy(params.partition as string, target, dshUrl, policy))
}

function matchesPolicy(
  partition: string,
  target: URL,
  dshUrl: string,
  policy: TrustedIsolatedSurfacePolicy
): boolean {
  const routeId = partition.slice(policy.partitionPrefix.length)
  if (!partition.startsWith(policy.partitionPrefix) || !/^[A-Za-z0-9-]{8,128}$/.test(routeId)) {
    return false
  }
  const allowedPaths = new Set([policy.path, resolveDshAppRoute(dshUrl, policy.path).pathname])
  if (!allowedPaths.has(target.pathname)) return false
  const keys = Array.from(target.searchParams.keys())
  return (
    keys.length === 2 &&
    keys.filter(key => key === policy.identityParameter).length === 1 &&
    keys.filter(key => key === policy.modeParameter).length === 1 &&
    Boolean(target.searchParams.get(policy.identityParameter)?.trim()) &&
    target.searchParams.get(policy.modeParameter) === policy.modeValue
  )
}
