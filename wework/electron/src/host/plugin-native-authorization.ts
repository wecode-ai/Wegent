import type { CloudCredentialService } from './cloud-credential-service.js'

type NativeRequest = (method: string, params: Record<string, unknown>) => Promise<unknown>

/** Only metadata crosses the renderer boundary; session material goes to Native. */
export class PluginNativeAuthorization {
  private revision = 0

  constructor(
    private readonly credentials: () => CloudCredentialService,
    private readonly request: NativeRequest
  ) {}

  async configure(apiBaseUrl: string, accountToken: string) {
    const revision = ++this.revision
    const session = await this.credentials().pluginNativeSession(apiBaseUrl, accountToken)
    if (revision !== this.revision) return { enabled: false, expiresIn: null }
    await this.request('executor.plugin_auth.configure', {
      configuration_revision: revision,
      session,
    })
    return {
      enabled: Boolean(session),
      expiresIn: session ? Math.max(1, session.expires_at - Math.floor(Date.now() / 1000)) : null,
    }
  }

  clear() {
    return this.request('executor.plugin_auth.configure', {
      configuration_revision: ++this.revision,
      session: null,
    }).catch((error: unknown) => {
      // A released runtime without this method never held a Native session.
      if (
        error instanceof Error &&
        error.message === 'Unsupported app IPC method: executor.plugin_auth.configure'
      )
        return
      throw error
    })
  }
}
