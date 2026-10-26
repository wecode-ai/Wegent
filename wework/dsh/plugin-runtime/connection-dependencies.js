import { ConnectionError, dependencyPlan } from './connections.js'

export class ConnectionDependencies {
  constructor(request, satisfies) {
    this.request = request
    this.satisfies = satisfies
    this.operation = Promise.resolve()
  }

  async inventory() {
    const response = await this.request('plugin/installed', { cwds: [] })
    if (!Array.isArray(response.marketplaces) || response.marketplaceLoadErrors?.length) {
      throw new ConnectionError(
        'dependency_catalog_failed',
        'Cannot read the complete Codex plugin catalog'
      )
    }
    return response.marketplaces.flatMap(marketplace => {
      if (!Array.isArray(marketplace.plugins))
        throw new ConnectionError('dependency_catalog_failed', 'Invalid Codex marketplace')
      return marketplace.plugins.map(plugin => ({
        marketplaceId: marketplace.name,
        pluginId: plugin.id,
        name: plugin.name,
        installed: plugin.installed === true,
        enabled: plugin.enabled === true,
        version: plugin.localVersion ?? plugin.version ?? null,
        marketplacePath: marketplace.path ?? null,
        availability: plugin.availability,
      }))
    })
  }

  async plan(definition, includeCatalog = false) {
    const installed = await this.inventory()
    if (!includeCatalog) return dependencyPlan(definition, installed, this.satisfies)
    const response = await this.request('plugin/list', { cwds: [] })
    if (!Array.isArray(response.marketplaces) || response.marketplaceLoadErrors?.length) {
      throw new ConnectionError('dependency_catalog_failed', 'Cannot read the Codex plugin catalog')
    }
    const inventory = [...installed]
    for (const marketplace of response.marketplaces) {
      for (const plugin of marketplace.plugins ?? []) {
        if (
          inventory.some(
            item => item.marketplaceId === marketplace.name && item.pluginId === plugin.id
          )
        )
          continue
        inventory.push({
          marketplaceId: marketplace.name,
          pluginId: plugin.id,
          name: plugin.name,
          installed: false,
          enabled: false,
          version: plugin.localVersion ?? plugin.version,
          marketplacePath: marketplace.path,
          availability: plugin.availability,
        })
      }
    }
    return dependencyPlan(definition, inventory, this.satisfies)
  }

  // Installation is explicit. Catalog reads and background collection never install anything.
  install(definition, aliases) {
    const operation = this.operation.then(async () => {
      const plan = await this.plan(definition, true)
      if (
        !Array.isArray(aliases) ||
        aliases.some(alias => !plan.some(item => item.alias === alias))
      ) {
        throw new ConnectionError('invalid_dependency', 'Unknown dependency alias')
      }
      for (const dependency of plan.filter(item => aliases.includes(item.alias))) {
        if (dependency.status === 'ready') continue
        if (dependency.status !== 'missing' || !dependency.resolved) {
          throw new ConnectionError(
            'dependency_conflict',
            `Resolve dependency ${dependency.alias} before installing`
          )
        }
        const target = dependency.resolved
        if (
          dependency.version !== '*' &&
          (!target.version || !this.satisfies(target.version, dependency.version))
        ) {
          throw new ConnectionError(
            'dependency_conflict',
            'The available dependency version is incompatible'
          )
        }
        if (target.availability === 'DISABLED_BY_ADMIN') {
          throw new ConnectionError(
            'dependency_denied',
            'Dependency installation is disabled by the administrator'
          )
        }
        // A shared installed dependency is never upgraded or enabled implicitly.
        await this.request('plugin/install', {
          pluginName: target.name,
          ...(target.marketplacePath
            ? { marketplacePath: target.marketplacePath }
            : { remoteMarketplaceName: target.marketplaceId }),
        })
      }
      return this.plan(definition)
    })
    this.operation = operation.catch(() => undefined)
    return operation
  }
}
