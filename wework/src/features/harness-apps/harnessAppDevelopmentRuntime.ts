import { harnessAppsApi, type HarnessAppInstallation } from '@/api/local/harnessApps'
import { unregisterHarnessAppTab } from './harnessAppTabs'

export async function stopHarnessAppDevelopmentRuntime(installationId: string): Promise<void> {
  await harnessAppsApi.stop(installationId)
  unregisterHarnessAppTab(installationId)
}

export async function startHarnessAppDevelopmentRuntime({
  installation,
  missingWebUrlMessage,
}: {
  installation: HarnessAppInstallation
  missingWebUrlMessage: string
}): Promise<HarnessAppInstallation> {
  const running = await harnessAppsApi.preparePreview(installation.id)
  if (!running.webUrl) throw new Error(missingWebUrlMessage)
  return running
}

export async function restartHarnessAppDevelopmentRuntime(
  installation: HarnessAppInstallation,
  missingWebUrlMessage: string
): Promise<HarnessAppInstallation> {
  if (installation.state === 'running') await stopHarnessAppDevelopmentRuntime(installation.id)
  return startHarnessAppDevelopmentRuntime({ installation, missingWebUrlMessage })
}
