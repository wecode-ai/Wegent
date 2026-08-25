export interface CoreDshPlugin {
  name: string
  displayName: string
  description: string
  version: string
  spec: string
  active: boolean
  immutable: boolean
  bundle: boolean
  client: boolean
  homepage: string
  repository: string
}

interface MutationPayload {
  ok?: boolean
  plugins?: CoreDshPlugin[]
  result?: { plugins?: CoreDshPlugin[] }
  error?: { message?: string; details?: { stdout?: string; stderr?: string } }
}

export async function readCoreDshPlugins(signal?: AbortSignal): Promise<CoreDshPlugin[]> {
  const response = await fetch('/wework/dsh/plugins', {
    headers: { accept: 'application/json' },
    signal,
  })
  const payload = (await response.json()) as MutationPayload
  if (!response.ok || !validPlugins(payload.plugins)) throw responseError(response.status, payload)
  return payload.plugins
}

export function installCoreDshPlugin(spec: string): Promise<CoreDshPlugin[]> {
  return mutate('install', { spec })
}

export function setCoreDshPluginActive(name: string, active: boolean): Promise<CoreDshPlugin[]> {
  return mutate(active ? 'activate' : 'deactivate', { name })
}

export function uninstallCoreDshPlugin(name: string): Promise<CoreDshPlugin[]> {
  return mutate('uninstall', { name })
}

export async function restartCoreDsh(): Promise<void> {
  const response = await fetch('/wework/dsh/plugins/restart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!response.ok) throw responseError(response.status, (await response.json()) as MutationPayload)
}

async function mutate(action: string, body: Record<string, string>): Promise<CoreDshPlugin[]> {
  const response = await fetch(`/wework/dsh/plugins/${action}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as MutationPayload
  if (!response.ok || payload.ok !== true || !validPlugins(payload.result?.plugins)) {
    throw responseError(response.status, payload)
  }
  return payload.result.plugins
}

function validPlugins(value: unknown): value is CoreDshPlugin[] {
  return (
    Array.isArray(value) &&
    value.every(plugin => {
      if (!plugin || typeof plugin !== 'object') return false
      const item = plugin as Partial<CoreDshPlugin>
      return (
        typeof item.name === 'string' &&
        typeof item.active === 'boolean' &&
        typeof item.immutable === 'boolean' &&
        typeof item.bundle === 'boolean'
      )
    })
  )
}

function responseError(status: number, payload: MutationPayload): Error {
  const message = payload.error?.message || `Core DSH plugin request failed with HTTP ${status}`
  const diagnostics = payload.error?.details?.stderr || payload.error?.details?.stdout
  return new Error(diagnostics ? `${message}\n${diagnostics}` : message)
}
