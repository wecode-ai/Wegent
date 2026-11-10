/** Provision Native credentials without returning their token to the renderer. */
export async function configurePluginNativeAuthorization(apiBaseUrl: string, token: string) {
  const bridge = (
    window as unknown as {
      weworkElectronPluginAuth?: {
        configure: (
          url: string,
          token: string
        ) => Promise<{
          ok: boolean
          value?: { enabled: boolean; expiresIn: number | null }
          error?: { code?: string }
        }>
      }
    }
  ).weworkElectronPluginAuth
  if (!bridge) return { ready: true, expiresIn: null }
  try {
    const response = await bridge.configure(apiBaseUrl, token)
    return {
      ready: response.ok || response.error?.code === 'credentials_unavailable',
      expiresIn: response.value?.expiresIn ?? null,
    }
  } catch {
    return { ready: false, expiresIn: null }
  }
}
