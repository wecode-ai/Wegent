/**
 * API client for version endpoints
 */
import type { DataVersion } from '@/types'

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:18000'

export interface VersionListResponse {
  items: DataVersion[]
  total: number
}

export async function getVersions(): Promise<VersionListResponse> {
  const response = await fetch(`${API_BASE_URL}/api/versions`)
  if (!response.ok) throw new Error('Failed to get versions')
  return response.json()
}

export async function getLatestVersion(): Promise<DataVersion> {
  const response = await fetch(`${API_BASE_URL}/api/versions/latest`)
  if (!response.ok) throw new Error('Failed to get latest version')
  return response.json()
}

export async function getVersion(versionId: number): Promise<DataVersion> {
  const response = await fetch(`${API_BASE_URL}/api/versions/${versionId}`)
  if (!response.ok) throw new Error('Failed to get version')
  return response.json()
}
