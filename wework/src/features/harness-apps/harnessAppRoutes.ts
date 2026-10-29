import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  takeHarnessAppAdditionalProxyTokens,
  takeHarnessAppContextToken,
  takeHarnessAppDecisionToken,
  takeHarnessAppProxyToken,
} from './harnessAppTabs'

export interface HarnessAppRouteTokens {
  proxyToken?: string | null
  additionalProxyTokens?: readonly string[]
  contextToken?: string | null
  decisionToken?: string | null
}

/**
 * Releases every route registration an installation owns. The routes are
 * independent, so one failing unregister must not strand the others.
 */
export async function releaseHarnessAppRoutes(
  installationId: string,
  localHarnessModelApi: WorkbenchServices['localHarnessModelApi'],
  localDecisionRouterApi: WorkbenchServices['localDecisionRouterApi'],
  retained: HarnessAppRouteTokens = {}
): Promise<void> {
  const [proxy, additional, context, decision] = await Promise.allSettled([
    takeHarnessAppProxyToken(installationId),
    takeHarnessAppAdditionalProxyTokens(installationId),
    takeHarnessAppContextToken(installationId),
    takeHarnessAppDecisionToken(installationId),
  ])
  // A failed host read cannot invalidate the handles retained by the launch.
  // Sets also prevent unregistering a route twice after a successful handoff.
  const proxies = new Set(
    [
      retained.proxyToken,
      ...(retained.additionalProxyTokens ?? []),
      ...(proxy.status === 'fulfilled' ? [proxy.value] : []),
      ...(additional.status === 'fulfilled' ? additional.value : []),
    ].filter((token): token is string => Boolean(token))
  )
  const contexts = new Set(
    [retained.contextToken, ...(context.status === 'fulfilled' ? [context.value] : [])].filter(
      (token): token is string => Boolean(token)
    )
  )
  const decisions = new Set(
    [retained.decisionToken, ...(decision.status === 'fulfilled' ? [decision.value] : [])].filter(
      (token): token is string => Boolean(token)
    )
  )
  await Promise.allSettled([
    ...[...proxies].map(token => localHarnessModelApi?.unregisterProxy(token)),
    ...[...contexts].map(token => localHarnessModelApi?.unregisterContext(token)),
    ...[...decisions].map(token => localDecisionRouterApi?.unregister(token)),
  ])
}
