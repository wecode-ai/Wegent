import {
  harnessAppsApi,
  type HarnessAppInstallation,
  type HarnessAppPreview,
} from '@/api/local/harnessApps'
import type { SmartAppMarketplaceItem, SmartAppsApi } from '@/api/smartApps'
import type { SmartAppIdentityContext } from '@/telemetry/facts'
import { beginOperation } from '@/telemetry/operationBus'
import { notifyHarnessAppInstallationsChanged } from './harnessAppInstallationsChanged'

export interface MarketplaceSmartAppPreparation {
  readonly intent: 'install' | 'update'
  readonly item: SmartAppMarketplaceItem
  readonly preview: HarnessAppPreview
}

function operationKey(intent: MarketplaceSmartAppPreparation['intent']) {
  return intent === 'install' ? ('smart_app.install' as const) : ('smart_app.update' as const)
}

function smartAppContext(installation: HarnessAppInstallation): SmartAppIdentityContext {
  return {
    key: installation.manifest.name,
    name: installation.manifest.displayName,
    source: installation.source,
    version: installation.manifest.version,
  }
}

function assertValidPreview(preview: HarnessAppPreview): void {
  if (!preview.valid || !preview.manifest) throw new Error('Invalid Smart App package')
}

function notifyInstalled(installation: HarnessAppInstallation): void {
  notifyHarnessAppInstallationsChanged({
    installation,
    installationId: installation.id,
    type: 'installed',
  })
}

export async function prepareMarketplaceSmartApp(
  api: Pick<SmartAppsApi, 'getDownload'>,
  item: SmartAppMarketplaceItem,
  intent: MarketplaceSmartAppPreparation['intent']
): Promise<MarketplaceSmartAppPreparation> {
  const attempt = beginOperation(operationKey(intent))
  let preview: HarnessAppPreview
  try {
    const descriptor = await api.getDownload(item.id)
    preview = await harnessAppsApi.download(descriptor)
  } catch (error) {
    attempt.fail('download')
    throw error
  }

  try {
    assertValidPreview(preview)
  } catch (error) {
    attempt.fail('validate')
    throw error
  }

  attempt.cancel()
  return { intent, item, preview }
}

export async function installMarketplaceSmartApp(
  preparation: MarketplaceSmartAppPreparation,
  modelKey: string
): Promise<HarnessAppInstallation> {
  const attempt = beginOperation(operationKey(preparation.intent))
  try {
    assertValidPreview(preparation.preview)
  } catch (error) {
    attempt.fail('validate')
    throw error
  }

  let installation: HarnessAppInstallation
  try {
    installation = await harnessAppsApi.install(preparation.preview, modelKey, {
      releaseId: preparation.item.latestReleaseId,
      smartAppId: preparation.item.id,
    })
  } catch (error) {
    attempt.fail('install')
    throw error
  }

  try {
    notifyInstalled(installation)
  } catch (error) {
    attempt.fail('confirm', { context: { smartApp: smartAppContext(installation) } })
    throw error
  }

  attempt.succeed({ context: { smartApp: smartAppContext(installation) } })
  return installation
}

export async function importSmartAppPackage(path: string): Promise<HarnessAppInstallation> {
  const attempt = beginOperation('smart_app.zip_import')
  let preview: HarnessAppPreview
  try {
    preview = await harnessAppsApi.preview(path)
  } catch (error) {
    attempt.fail('preview')
    throw error
  }

  try {
    assertValidPreview(preview)
  } catch (error) {
    attempt.fail('validate')
    throw error
  }

  let installation: HarnessAppInstallation
  try {
    installation = await harnessAppsApi.install(preview, null)
  } catch (error) {
    attempt.fail('install')
    throw error
  }

  try {
    notifyInstalled(installation)
  } catch (error) {
    attempt.fail('confirm', { context: { smartApp: smartAppContext(installation) } })
    throw error
  }

  attempt.succeed({ context: { smartApp: smartAppContext(installation) } })
  return installation
}
