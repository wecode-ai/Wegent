// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Skill, SkillList } from '@/types/api'
import {
  CategoryListResponse,
  GhostSkill,
  MarketSkill,
  secretsResponse,
  SkillListResponse,
  SkillStatus,
  SkillSuccessResponse,
  SkillType,
} from '@/types/skill'
import { getToken } from './user'

const API_BASE_URL = '/api'

// ==================== CRD Skill APIs (Claude Code ZIP Skills) ====================

/**
 * Fetch all skills for the current user
 */
export async function fetchSkillsList(params?: {
  skip?: number
  limit?: number
  namespace?: string
}): Promise<Skill[]> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const queryParams = new URLSearchParams()
  if (params?.skip !== undefined) queryParams.append('skip', params.skip.toString())
  if (params?.limit !== undefined) queryParams.append('limit', params.limit.toString())
  if (params?.namespace) queryParams.append('namespace', params.namespace)

  const url = `${API_BASE_URL}/v1/kinds/skills?${queryParams.toString()}`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(error || 'Failed to fetch skills')
  }

  const data: SkillList = await response.json()
  return data.items
}

/**
 * Fetch a skill by name
 */
export async function fetchSkillByName(
  name: string,
  namespace: string = 'default'
): Promise<Skill | null> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${API_BASE_URL}/v1/kinds/skills?name=${encodeURIComponent(name)}&namespace=${encodeURIComponent(namespace)}`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(error || 'Failed to fetch skill')
  }

  const data: SkillList = await response.json()
  return data.items.length > 0 ? data.items[0] : null
}

/**
 * Get skill by ID
 */
export async function getSkill(skillId: number): Promise<Skill> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${API_BASE_URL}/v1/kinds/skills/${skillId}`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(error || 'Failed to get skill')
  }

  return response.json()
}

/**
 * Upload a new skill
 */
export async function uploadSkill(
  file: File,
  name: string,
  namespace: string = 'default',
  onProgress?: (progress: number) => void
): Promise<Skill> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const formData = new FormData()
  formData.append('file', file)
  formData.append('name', name)
  formData.append('namespace', namespace)

  const url = `${API_BASE_URL}/v1/kinds/skills/upload`

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    // Progress tracking
    if (onProgress) {
      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) {
          const progress = Math.round((e.loaded / e.total) * 100)
          onProgress(progress)
        }
      })
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText)
          resolve(data)
        } catch {
          reject(new Error('Invalid response format'))
        }
      } else {
        try {
          const error = JSON.parse(xhr.responseText)
          reject(new Error(error.detail || 'Failed to upload skill'))
        } catch {
          reject(new Error(xhr.responseText || 'Failed to upload skill'))
        }
      }
    })

    xhr.addEventListener('error', () => {
      reject(new Error('Network error during upload'))
    })

    xhr.open('POST', url)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.send(formData)
  })
}

/**
 * Update an existing skill
 */
export async function updateSkill(
  skillId: number,
  file: File,
  onProgress?: (progress: number) => void
): Promise<Skill> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const formData = new FormData()
  formData.append('file', file)

  const url = `${API_BASE_URL}/v1/kinds/skills/${skillId}`

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    if (onProgress) {
      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) {
          const progress = Math.round((e.loaded / e.total) * 100)
          onProgress(progress)
        }
      })
    }

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText)
          resolve(data)
        } catch {
          reject(new Error('Invalid response format'))
        }
      } else {
        try {
          const error = JSON.parse(xhr.responseText)
          reject(new Error(error.detail || 'Failed to update skill'))
        } catch {
          reject(new Error(xhr.responseText || 'Failed to update skill'))
        }
      }
    })

    xhr.addEventListener('error', () => {
      reject(new Error('Network error during update'))
    })

    xhr.open('PUT', url)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.send(formData)
  })
}

/**
 * Delete a skill
 */
export async function deleteSkill(skillId: number): Promise<void> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${API_BASE_URL}/v1/kinds/skills/${skillId}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to delete skill')
    } catch {
      throw new Error(error || 'Failed to delete skill')
    }
  }
}

/**
 * Download a skill ZIP file
 */
export async function downloadSkill(skillId: number, skillName: string): Promise<void> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${API_BASE_URL}/v1/kinds/skills/${skillId}/download`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(error || 'Failed to download skill')
  }

  // Create blob and trigger download
  const blob = await response.blob()
  const downloadUrl = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = downloadUrl
  link.download = `${skillName}.zip`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.URL.revokeObjectURL(downloadUrl)
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes?: number): string {
  if (!bytes) return 'Unknown'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ==================== Skill Market APIs ====================

/**
 * List skills from the market
 */
export async function listMarketSkills(params?: {
  skillType?: SkillType
  category?: string
  visibility?: string
  search?: string
  page?: number
  pageSize?: number
}): Promise<SkillListResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const queryParams = new URLSearchParams()
  if (params?.skillType) queryParams.append('skill_type', params.skillType)
  if (params?.category) queryParams.append('category', params.category)
  if (params?.visibility) queryParams.append('visibility', params.visibility)
  if (params?.search) queryParams.append('search', params.search)
  if (params?.page) queryParams.append('page', params.page.toString())
  if (params?.pageSize) queryParams.append('pageSize', params.pageSize.toString())

  const url = `${API_BASE_URL}/skills/market?${queryParams.toString()}`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(error || 'Failed to fetch market skills')
  }

  return response.json()
}

/**
 * Get skill categories
 */
export async function getSkillCategories(): Promise<string[]> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${API_BASE_URL}/skills/market/categories`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(error || 'Failed to fetch categories')
  }

  const data: CategoryListResponse = await response.json()
  return data.categories
}

/**
 * Get a single skill from the market by name
 */
export async function getMarketSkill(skillName: string): Promise<MarketSkill> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${API_BASE_URL}/skills/market/${encodeURIComponent(skillName)}`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(error || 'Failed to fetch skill')
  }

  return response.json()
}

// ==================== Ghost-Skill Association APIs ====================

/**
 * List all skills in a Ghost
 */
export async function listGhostSkills(ghostId: number): Promise<GhostSkill[]> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${API_BASE_URL}/skills/ghosts/${ghostId}/skills`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(error || 'Failed to fetch ghost skills')
  }

  return response.json()
}

/**
 * Add a skill to a Ghost
 */
export async function addSkillToGhost(
  ghostId: number,
  skillName: string
): Promise<SkillSuccessResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${API_BASE_URL}/skills/ghosts/${ghostId}/skills`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ skillName }),
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to add skill')
    } catch {
      throw new Error(error || 'Failed to add skill')
    }
  }

  return response.json()
}

/**
 * Remove a skill from a Ghost
 */
export async function removeSkillFromGhost(
  ghostId: number,
  skillName: string
): Promise<SkillSuccessResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${API_BASE_URL}/skills/ghosts/${ghostId}/skills/${encodeURIComponent(skillName)}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to remove skill')
    } catch {
      throw new Error(error || 'Failed to remove skill')
    }
  }

  return response.json()
}

/**
 * Update skill status in a Ghost
 */
export async function updateGhostSkillStatus(
  ghostId: number,
  skillName: string,
  status: SkillStatus
): Promise<SkillSuccessResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${API_BASE_URL}/skills/ghosts/${ghostId}/skills/${encodeURIComponent(skillName)}/status`
  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ status }),
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to update status')
    } catch {
      throw new Error(error || 'Failed to update status')
    }
  }

  return response.json()
}

// ==================== secrets Management APIs ====================

/**
 * Get secrets for a skill in a Ghost
 */
export async function getSkillsecrets(
  ghostId: number,
  skillName: string
): Promise<secretsResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${API_BASE_URL}/skills/ghosts/${ghostId}/skills/${encodeURIComponent(skillName)}/secrets`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(error || 'Failed to fetch secrets')
  }

  return response.json()
}

/**
 * Set secrets for a skill in a Ghost
 */
export async function setSkillsecrets(
  ghostId: number,
  skillName: string,
  envValues: Record<string, string>
): Promise<SkillSuccessResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${API_BASE_URL}/skills/ghosts/${ghostId}/skills/${encodeURIComponent(skillName)}/secrets`
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ envValues }),
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to set secrets')
    } catch {
      throw new Error(error || 'Failed to set secrets')
    }
  }

  return response.json()
}

/**
 * Delete secrets for a skill in a Ghost
 */
export async function deleteSkillsecrets(
  ghostId: number,
  skillName: string
): Promise<SkillSuccessResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${API_BASE_URL}/skills/ghosts/${ghostId}/skills/${encodeURIComponent(skillName)}/secrets`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to delete secrets')
    } catch {
      throw new Error(error || 'Failed to delete secrets')
    }
  }

  return response.json()
}
