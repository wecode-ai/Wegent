import type { WegentConnectorApp, WegentInstalledConnectorApp } from '@/api/cloud/connectorApps'

/** Preserve the same callable tools and authorization guidance in every full sync. */
export function connectorAppCatalog(
  installed: { apps: WegentInstalledConnectorApp[] },
  catalog: WegentConnectorApp[]
) {
  const callable = installed.apps
    .filter(app => app.enabled && app.callable)
    .map(app => ({
      slug: app.slug,
      name: app.runtime_name ?? app.slug,
      description: app.description ?? '',
      toolLoadingMode: app.tool_loading_mode ?? 'static',
      tools: app.tool_summaries ?? [],
      authorizationRequired: false,
    }))
  // Unauthorized apps still get a Skill so the agent knows the capability
  // exists and asks the user to authorize instead of denying it.
  const callableSlugs = new Set(callable.map(app => app.slug))
  const awaitingAuthorization = catalog
    .filter(
      app =>
        app.auth_type === 'oauth2' &&
        app.connection.status !== 'connected' &&
        !callableSlugs.has(app.slug)
    )
    .map(app => ({
      slug: app.slug,
      name: app.name,
      description: app.description ?? '',
      toolLoadingMode: app.tool_loading_mode,
      tools: [],
      authorizationRequired: true,
    }))
  return { apps: [...callable, ...awaitingAuthorization], callableSlugs: [...callableSlugs] }
}
