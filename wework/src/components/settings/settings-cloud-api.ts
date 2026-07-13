import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import { createModelApi } from '@/api/models'
import { getRuntimeConfig } from '@/config/runtime'

export interface CloudSettingsConnection {
  isConnected: boolean
  apiBaseUrl?: string
  token: string | null
}

export function createSettingsDeviceApi(connection: CloudSettingsConnection) {
  if (!connection.isConnected || !connection.apiBaseUrl || !connection.token) {
    throw new Error('Cloud connection is required')
  }
  return createDeviceApi(
    createHttpClient({
      baseUrl: connection.apiBaseUrl,
      getToken: () => connection.token,
      redirectOnUnauthorized: false,
    })
  )
}

export function createActiveSettingsDeviceApi(connection: CloudSettingsConnection) {
  if (connection.isConnected) {
    return createSettingsDeviceApi(connection)
  }

  const { apiBaseUrl } = getRuntimeConfig()
  return createDeviceApi(createHttpClient({ baseUrl: apiBaseUrl }))
}

export function createSettingsModelApi(connection: CloudSettingsConnection) {
  if (!connection.isConnected || !connection.apiBaseUrl || !connection.token) {
    throw new Error('Cloud connection is required')
  }
  return createModelApi(
    createHttpClient({
      baseUrl: connection.apiBaseUrl,
      getToken: () => connection.token,
      redirectOnUnauthorized: false,
    })
  )
}
