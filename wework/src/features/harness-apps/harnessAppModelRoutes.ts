import type { LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'

type LocalHarnessModelApi = NonNullable<WorkbenchServices['localHarnessModelApi']>

export interface HarnessAppAdditionalModel {
  modelKey: string
  displayName: string
  baseUrl: string
}

export async function registerAdditionalHarnessAppModels(
  selectedModel: LocalHarnessModelOption,
  modelOptions: LocalHarnessModelOption[],
  modelApi: LocalHarnessModelApi,
  onRegistered: (token: string) => void
): Promise<HarnessAppAdditionalModel[]> {
  const registrations = await Promise.all(
    modelOptions
      .filter(option => option.key !== selectedModel.key)
      .map(async option => {
        try {
          const launch = await modelApi.resolveLaunch('opencode', option, undefined, false)
          if (!launch) return null
          return {
            model: { modelKey: option.key, displayName: option.label, baseUrl: launch.baseUrl },
            token: launch.proxyToken,
          }
        } catch (error) {
          console.warn(
            '[Wework] additional Smart app model route unavailable',
            option.key,
            error instanceof Error ? error.name : 'unknown'
          )
          return null
        }
      })
  )
  const additionalModels: HarnessAppAdditionalModel[] = []
  for (const registration of registrations) {
    if (!registration) continue
    onRegistered(registration.token)
    additionalModels.push(registration.model)
  }
  return additionalModels
}
