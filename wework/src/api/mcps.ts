import type {
  InstalledMCPCustomCreateRequest,
  InstalledMCP,
  InstalledMCPInstallRequest,
  InstalledMCPListResponse,
  InstalledMCPUpdateRequest,
  MCPProviderKeysRequest,
  MCPProviderKeysResponse,
  MCPProviderListResponse,
  MCPServerListResponse,
} from '@/types/api'
import type { HttpClient } from './http'

export function createMcpApi(client: HttpClient) {
  return {
    listProviders(): Promise<MCPProviderListResponse> {
      return client.get('/mcp-providers')
    },
    updateProviderKeys(
      data: MCPProviderKeysRequest,
    ): Promise<MCPProviderKeysResponse> {
      return client.put('/mcp-providers/keys', data)
    },
    listProviderServers(providerKey: string): Promise<MCPServerListResponse> {
      return client.post(`/mcp-providers/${providerKey}/servers`)
    },
    listInstalledMcps(): Promise<InstalledMCPListResponse> {
      return client.get('/mcps/installed')
    },
    createCustomMcp(
      data: InstalledMCPCustomCreateRequest,
    ): Promise<InstalledMCP> {
      return client.post('/mcps/custom', data)
    },
    installProviderMcp(data: InstalledMCPInstallRequest): Promise<InstalledMCP> {
      return client.post('/mcps/install', data)
    },
    updateInstalledMcp(
      id: number,
      data: InstalledMCPUpdateRequest,
    ): Promise<InstalledMCP> {
      return client.put(`/mcps/installed/${id}`, data)
    },
    uninstallInstalledMcp(id: number): Promise<void> {
      return client.delete(`/mcps/installed/${id}`)
    },
  }
}
