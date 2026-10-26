import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  takeHarnessAppAdditionalProxyTokens,
  takeHarnessAppContextToken,
  takeHarnessAppDecisionToken,
  takeHarnessAppProxyToken,
} from './harnessAppTabs'

/**
 * Releases every route registration an installation owns. The routes are
 * independent, so one failing unregister must not strand the others.
 */
export async function releaseHarnessAppRoutes(
  installationId: string,
  localHarnessModelApi: WorkbenchServices['localHarnessModelApi'],
  localDecisionRouterApi: WorkbenchServices['localDecisionRouterApi']
): Promise<void> {
  await Promise.allSettled([
    takeHarnessAppAdditionalProxyTokens(installationId).then(tokens =>
      Promise.allSettled(tokens.map(token => localHarnessModelApi?.unregisterProxy(token)))
    ),
    takeHarnessAppProxyToken(installationId).then(token =>
      token ? localHarnessModelApi?.unregisterProxy(token) : undefined
    ),
    takeHarnessAppContextToken(installationId).then(token =>
      token ? localHarnessModelApi?.unregisterContext(token) : undefined
    ),
    takeHarnessAppDecisionToken(installationId).then(token =>
      token ? localDecisionRouterApi?.unregister(token) : undefined
    ),
  ])
}
