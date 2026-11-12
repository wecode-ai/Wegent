export const DECISION_ROUTER_PROTOCOL_VERSION = 1
const DECISION_ROUTER_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const DECISION_ROUTE_TOKEN = /^[A-Za-z0-9._~-]{8,200}$/
const MODEL_ROUTE_PATH = /^\/v1\/harness-router\/([A-Za-z0-9._~-]{8,200})$/

/** Validate the Host-owned decision lease against the installed manifest contract. */
export function authorizeDecisionRoute(
  manifest: WorkbenchAppManifest,
  decisionBaseUrl: string | null | undefined,
  decisionProtocolVersion: number | null | undefined
): { baseUrl: string; protocolVersion: 1 } | null {
  const requested = typeof decisionBaseUrl === 'string' ? decisionBaseUrl.trim() : ''
  if (!requested) return null
  if (!decideDecisionModelGrant(manifest))
    throw new Error('Smart app is not authorized to use the Wework decision router')
  if (decisionProtocolVersion !== DECISION_ROUTER_PROTOCOL_VERSION)
    throw new Error('Wework decision router protocol version is not supported')
  return {
    baseUrl: validateDecisionRouteUrl(requested),
    protocolVersion: DECISION_ROUTER_PROTOCOL_VERSION,
  }
}

export function validateAdditionalModelRoute(route: {
  modelKey: string
  displayName: string
  baseUrl: string
}): { modelKey: string; displayName: string; baseUrl: string } {
  let url: URL
  try {
    url = new URL(route.baseUrl)
  } catch {
    throw new Error('Wework model router base URL is not a valid URL')
  }
  if (
    url.protocol !== 'http:' ||
    !DECISION_ROUTER_LOOPBACK_HOSTS.has(url.hostname) ||
    Boolean(url.username || url.password || url.search || url.hash) ||
    !MODEL_ROUTE_PATH.test(url.pathname)
  ) {
    throw new Error('Wework model router base URL must be a local harness route')
  }
  if (!route.modelKey.trim() || !route.displayName.trim()) {
    throw new Error('Wework model router requires a model key and display name')
  }
  return {
    modelKey: route.modelKey.trim(),
    displayName: route.displayName.trim(),
    baseUrl: url.href,
  }
}

/**
 * Accepts only the loopback route Wework itself hands to a Smart app: an
 * `http:` base URL whose path is exactly `/v1/decision-router/<token>`.
 *
 * Credentials, a query, a fragment, another host, or a deeper path are all
 * rejected so a malformed value cannot aim the app at another service.
 */
export function validateDecisionRouteUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Wework decision router base URL is not a valid URL')
  }
  if (
    url.protocol !== 'http:' ||
    !DECISION_ROUTER_LOOPBACK_HOSTS.has(url.hostname) ||
    Boolean(url.username) ||
    Boolean(url.password) ||
    Boolean(url.search) ||
    Boolean(url.hash)
  ) {
    throw new Error('Wework decision router base URL must be a loopback address')
  }
  const segments = url.pathname.split('/')
  const token = segments[3] ?? ''
  if (
    segments.length !== 4 ||
    segments[1] !== 'v1' ||
    segments[2] !== 'decision-router' ||
    !DECISION_ROUTE_TOKEN.test(token)
  ) {
    throw new Error('Wework decision router base URL has an invalid route path')
  }
  return raw
}
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import { decideDecisionModelGrant } from './smart-app-capability-policy.js'
