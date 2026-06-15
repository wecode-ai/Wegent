import type { User, UserPreferences } from '@/types/api'
import type { HttpClient } from './http'

export type UserRuntime = 'codex'

export interface UpdateCurrentUserRequest {
  preferences?: UserPreferences
}

export interface UserRuntimeConfig {
  runtime: UserRuntime
  display_name: string
  use_user_config: boolean
  use_proxy: boolean
  configured: boolean
  target_path: string
  auth_json_sha256?: string | null
  auth_json_updated_at?: string | null
  proxy_configured: boolean
  proxy_url_masked: string
  proxy_updated_at?: string | null
  updated_at?: string | null
}

export interface UserProxyConfig {
  configured: boolean
  proxy_url_masked: string
  proxy_updated_at?: string | null
  updated_at?: string | null
}

export interface UpdateUserRuntimeConfigRequest {
  use_user_config: boolean
  use_proxy?: boolean
}

function runtimeConfigPath(runtime: UserRuntime) {
  return `/users/me/runtime-configs/${encodeURIComponent(runtime)}`
}

export function createUserApi(client: HttpClient) {
  return {
    updateCurrentUser(data: UpdateCurrentUserRequest): Promise<User> {
      return client.put('/users/me', data)
    },
    getRuntimeConfig(runtime: UserRuntime): Promise<UserRuntimeConfig> {
      return client.get(runtimeConfigPath(runtime))
    },
    updateRuntimeConfig(
      runtime: UserRuntime,
      data: UpdateUserRuntimeConfigRequest,
    ): Promise<UserRuntimeConfig> {
      return client.put(runtimeConfigPath(runtime), data)
    },
    getProxyConfig(): Promise<UserProxyConfig> {
      return client.get('/users/me/proxy-config')
    },
    updateProxyConfig(proxyUrl: string): Promise<UserProxyConfig> {
      return client.put('/users/me/proxy-config', {
        proxy_url: proxyUrl,
      })
    },
    uploadRuntimeAuthJson(
      runtime: UserRuntime,
      authJson: string,
    ): Promise<UserRuntimeConfig> {
      return client.post(`${runtimeConfigPath(runtime)}/auth-json`, {
        auth_json: authJson,
      })
    },
    importRuntimeAuthJson(
      runtime: UserRuntime,
      deviceId: string,
    ): Promise<UserRuntimeConfig> {
      return client.post(`${runtimeConfigPath(runtime)}/import-device`, {
        device_id: deviceId,
      })
    },
  }
}
