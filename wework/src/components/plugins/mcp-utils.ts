import type {
  InstalledMCPServerConfig,
  MCPServer,
} from '@/types/api'

export function serverKeyFromProviderServer(server: MCPServer): string {
  return server.id.includes('/') ? server.id.split('/').slice(1).join('/') : server.id
}

export function serverConfigFromProviderServer(
  server: MCPServer,
): InstalledMCPServerConfig {
  return {
    type: server.type,
    url: server.base_url ?? undefined,
    base_url: server.base_url ?? undefined,
    command: server.command ?? undefined,
    args: server.args ?? undefined,
    env: server.env ?? undefined,
    headers: server.headers ?? undefined,
  }
}
