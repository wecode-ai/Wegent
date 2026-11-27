import { performance } from 'node:perf_hooks'

export function observeSmartAppInstall(environment: NodeJS.ProcessEnv) {
  if (environment.VITE_WEWORK_E2E !== 'true' || !environment.WEWORK_E2E_CONTROL_URL?.trim())
    return undefined
  const startedAt = performance.now()
  return (stage: string, running?: boolean): void => {
    console.info('[smart-app-install]', {
      stage,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...(running === undefined ? {} : { running }),
    })
  }
}
