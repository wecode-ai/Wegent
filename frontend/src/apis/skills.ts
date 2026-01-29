// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Skill, SkillList } from '@/types/api'
import { getToken } from './user'
import { getApiBaseUrl } from '@/lib/runtime-config'

// Use dynamic API base URL from runtime config
const getApiUrl = () => getApiBaseUrl()

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

  const url = `${getApiUrl()}/v1/kinds/skills?${queryParams.toString()}`
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
 * @param name - Skill name
 * @param namespace - Namespace to search in (default: 'default')
 * @param exactMatch - If true, only search in the specified namespace.
 *                     If false, search with fallback: personal -> group -> public.
 *                     Use true for upload duplicate check, false for skill usage.
 */
export async function fetchSkillByName(
  name: string,
  namespace: string = 'default',
  exactMatch: boolean = true
): Promise<Skill | null> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${getApiUrl()}/v1/kinds/skills?name=${encodeURIComponent(name)}&namespace=${encodeURIComponent(namespace)}&exact_match=${exactMatch}`
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

  const url = `${getApiUrl()}/v1/kinds/skills/${skillId}`
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

  const url = `${getApiUrl()}/v1/kinds/skills/upload`

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

  const url = `${getApiUrl()}/v1/kinds/skills/${skillId}`

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

  const url = `${getApiUrl()}/v1/kinds/skills/${skillId}`
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
 * @param skillId - Skill ID
 * @param skillName - Skill name (used for the downloaded file name)
 * @param namespace - Namespace for group skill lookup (optional; when omitted, backend uses 'default')
 */
export async function downloadSkill(
  skillId: number,
  skillName: string,
  namespace?: string
): Promise<void> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const queryParams = new URLSearchParams()
  if (namespace) queryParams.append('namespace', namespace)

  const queryString = queryParams.toString()
  const url = `${getApiUrl()}/v1/kinds/skills/${skillId}/download${queryString ? `?${queryString}` : ''}`
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

// ============================================================================
// Unified Skills API (User + Public)
// ============================================================================

/**
 * Skill source information for git-imported skills
 */
export interface SkillSource {
  type: 'upload' | 'git'
  repo_url?: string
  skill_path?: string
  imported_at?: string
}

/**
 * Unified skill response type
 */
export interface UnifiedSkill {
  id: number
  name: string
  namespace: string
  description: string
  displayName?: string
  prompt?: string
  version?: string
  author?: string
  tags?: string[]
  /** List of shell types this skill is compatible with (e.g., 'ClaudeCode', 'Agno', 'Dify', 'Chat') */
  bindShells?: string[]
  is_active: boolean
  is_public: boolean
  user_id: number // ID of the user who uploaded this skill
  /** Source information for git-imported skills */
  source?: SkillSource
  created_at?: string
  updated_at?: string
}

/**
 * Fetch unified skills list (user's + public)
 */
export async function fetchUnifiedSkillsList(params?: {
  skip?: number
  limit?: number
  scope?: 'personal' | 'group' | 'all'
  groupName?: string
}): Promise<UnifiedSkill[]> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const queryParams = new URLSearchParams()
  if (params?.skip !== undefined) queryParams.append('skip', params.skip.toString())
  if (params?.limit !== undefined) queryParams.append('limit', params.limit.toString())
  if (params?.scope) queryParams.append('scope', params.scope)
  if (params?.groupName) queryParams.append('group_name', params.groupName)

  const url = `${getApiUrl()}/v1/kinds/skills/unified?${queryParams.toString()}`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(error || 'Failed to fetch unified skills')
  }

  return response.json()
}

/**
 * Fetch public skills list
 */
export async function fetchPublicSkillsList(params?: {
  skip?: number
  limit?: number
}): Promise<UnifiedSkill[]> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const queryParams = new URLSearchParams()
  if (params?.skip !== undefined) queryParams.append('skip', params.skip.toString())
  if (params?.limit !== undefined) queryParams.append('limit', params.limit.toString())

  const url = `${getApiUrl()}/v1/kinds/skills/public/list?${queryParams.toString()}`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(error || 'Failed to fetch public skills')
  }

  return response.json()
}

/**
 * Invoke a skill to get its prompt content
 */
export async function invokeSkill(skillName: string): Promise<{ prompt: string }> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${getApiUrl()}/v1/kinds/skills/invoke`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ skill_name: skillName }),
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to invoke skill')
    } catch {
      throw new Error(error || 'Failed to invoke skill')
    }
  }

  return response.json()
}

// ============================================================================
// Public Skills Admin API (Admin only)
// ============================================================================

/**
 * Upload a new public skill (Admin only)
 */
export async function uploadPublicSkill(
  file: File,
  name: string,
  onProgress?: (progress: number) => void
): Promise<UnifiedSkill> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const formData = new FormData()
  formData.append('file', file)
  formData.append('name', name)

  const url = `${getApiUrl()}/v1/kinds/skills/public/upload`

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
          reject(new Error(error.detail || 'Failed to upload public skill'))
        } catch {
          reject(new Error(xhr.responseText || 'Failed to upload public skill'))
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
 * Update an existing public skill with new ZIP (Admin only)
 */
export async function updatePublicSkillWithUpload(
  skillId: number,
  file: File,
  onProgress?: (progress: number) => void
): Promise<UnifiedSkill> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const formData = new FormData()
  formData.append('file', file)

  const url = `${getApiUrl()}/v1/kinds/skills/public/${skillId}/upload`

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
          reject(new Error(error.detail || 'Failed to update public skill'))
        } catch {
          reject(new Error(xhr.responseText || 'Failed to update public skill'))
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
 * Delete a public skill (Admin only)
 */
export async function deletePublicSkill(skillId: number): Promise<void> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${getApiUrl()}/v1/kinds/skills/public/${skillId}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to delete public skill')
    } catch {
      throw new Error(error || 'Failed to delete public skill')
    }
  }
}

/**
 * Download a public skill le
 */
export async function downloadPublicSkill(skillId: number, skillName: string): Promise<void> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${getApiUrl()}/v1/kinds/skills/public/${skillId}/download`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(error || 'Failed to download public skill')
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
 * Get the SKILL.md content from a public skill ZIP package
 */
export async function getPublicSkillContent(skillId: number): Promise<{ content: string }> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${getApiUrl()}/v1/kinds/skills/public/${skillId}/content`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to get skill content')
    } catch {
      throw new Error(error || 'Failed to get skill content')
    }
  }

  return response.json()
}

// ============================================================================
// Skill Reference Management API
// ============================================================================

/**
 * Referenced Ghost information returned when skill deletion fails
 */
export interface ReferencedGhost {
  id: number
  name: string
  namespace: string
}

/**
 * Structured error response when skill deletion fails due to references
 */
export interface SkillReferenceError {
  code: 'SKILL_REFERENCED'
  message: string
  skill_name: string
  referenced_ghosts: ReferencedGhost[]
}

/**
 * Response from remove references API
 */
export interface RemoveReferencesResponse {
  removed_count: number
  affected_ghosts: string[]
}

/**
 * Response from remove single reference API
 */
export interface RemoveSingleReferenceResponse {
  success: boolean
  ghost_name: string
}

/**
 * Remove all Ghost references to a Skill
 * This allows the Skill to be deleted afterwards
 */
export async function removeSkillReferences(skillId: number): Promise<RemoveReferencesResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${getApiUrl()}/v1/kinds/skills/${skillId}/remove-references`
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to remove skill references')
    } catch {
      throw new Error(error || 'Failed to remove skill references')
    }
  }

  return response.json()
}

/**
 * Remove a Skill reference from a single Ghost
 */
export async function removeSingleSkillReference(
  skillId: number,
  ghostId: number
): Promise<RemoveSingleReferenceResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${getApiUrl()}/v1/kinds/skills/${skillId}/remove-reference/${ghostId}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to remove skill reference')
    } catch {
      throw new Error(error || 'Failed to remove skill reference')
    }
  }

  return response.json()
}

/**
 * Helper function to parse skill reference error from API response
 */
export function parseSkillReferenceError(errorMessage: string): SkillReferenceError | null {
  try {
    const parsed = JSON.parse(errorMessage)
    if (parsed.code === 'SKILL_REFERENCED') {
      return parsed as SkillReferenceError
    }
    // Handle nested detail structure
    if (
      parsed.detail &&
      typeof parsed.detail === 'object' &&
      parsed.detail.code === 'SKILL_REFERENCED'
    ) {
      return parsed.detail as SkillReferenceError
    }
  } catch {
    // Not a JSON error
  }
  return null
}

// ============================================================================
// Git Repository Import API
// ============================================================================

/**
 * Skill information found in a Git repository
 */
export interface GitSkillInfo {
  path: string
  name: string
  description: string
  version?: string
  author?: string
  display_name?: string
  tags?: string[]
}

/**
 * Response from scanning a Git repository
 */
export interface GitScanResponse {
  repo_url: string
  skills: GitSkillInfo[]
  total_count: number
}

/**
 * Request to import skills from a Git repository
 */
export interface GitImportRequest {
  repo_url: string
  skill_paths: string[]
  namespace?: string
  overwrite_names?: string[]
}

/**
 * Successfully imported skill
 */
export interface GitImportSuccessItem {
  name: string
  path: string
  id: number
  action: 'created' | 'updated'
}

/**
 * Skipped skill (due to name conflict)
 */
export interface GitImportSkippedItem {
  name: string
  path: string
  reason: string
}

/**
 * Failed skill import
 */
export interface GitImportFailedItem {
  name: string
  path: string
  error: string
}

/**
 * Response from importing skills from a Git repository
 */
export interface GitImportResponse {
  success: GitImportSuccessItem[]
  skipped: GitImportSkippedItem[]
  failed: GitImportFailedItem[]
  total_success: number
  total_skipped: number
  total_failed: number
}

/**
 * Scan a Git repository for skills (personal skills)
 */
export async function scanGitRepoSkills(repoUrl: string): Promise<GitScanResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${getApiUrl()}/v1/kinds/skills/git/scan?repo_url=${encodeURIComponent(repoUrl)}`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to scan repository')
    } catch {
      throw new Error(error || 'Failed to scan repository')
    }
  }

  return response.json()
}

/**
 * Import skills from a Git repository (personal skills)
 */
export async function importGitRepoSkills(request: GitImportRequest): Promise<GitImportResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${getApiUrl()}/v1/kinds/skills/git/import`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to import skills')
    } catch {
      throw new Error(error || 'Failed to import skills')
    }
  }

  return response.json()
}

/**
 * Scan a Git repository for skills (public skills, admin only)
 */
export async function scanGitRepoPublicSkills(repoUrl: string): Promise<GitScanResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${getApiUrl()}/v1/kinds/skills/public/git/scan?repo_url=${encodeURIComponent(repoUrl)}`
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to scan repository')
    } catch {
      throw new Error(error || 'Failed to scan repository')
    }
  }

  return response.json()
}

/**
 * Import skills from a Git repository as public skills (admin only)
 */
export async function importGitRepoPublicSkills(
  request: Omit<GitImportRequest, 'namespace'>
): Promise<GitImportResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${getApiUrl()}/v1/kinds/skills/public/git/import`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to import skills')
    } catch {
      throw new Error(error || 'Failed to import skills')
    }
  }

  return response.json()
}

// ============================================================================
// Git Skill Update API
// ============================================================================

/**
 * Response from updating a skill from Git
 */
export interface UpdateFromGitResponse {
  id: number
  name: string
  message: string
}

/**
 * Update a skill from its original Git repository
 * Only works for skills that were imported from Git (source.type === 'git')
 */
export async function updateSkillFromGit(skillId: number): Promise<UpdateFromGitResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${getApiUrl()}/v1/kinds/skills/${skillId}/update-from-git`
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to update skill from Git')
    } catch {
      throw new Error(error || 'Failed to update skill from Git')
    }
  }

  return response.json()
}

/**
 * Update a public skill from its original Git repository (Admin only)
 * Only works for skills that were imported from Git (source.type === 'git')
 */
export async function updatePublicSkillFromGit(skillId: number): Promise<UpdateFromGitResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${getApiUrl()}/v1/kinds/skills/public/${skillId}/update-from-git`
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to update public skill from Git')
    } catch {
      throw new Error(error || 'Failed to update public skill from Git')
    }
  }

  return response.json()
}

// ============================================================================
// Git Skill Batch Update API
// ============================================================================

/**
 * Request to batch update skills from their Git repository sources
 */
export interface GitBatchUpdateRequest {
  skill_ids: number[]
}

/**
 * Successfully updated skill information
 */
export interface GitBatchUpdateSuccessItem {
  id: number
  name: string
  version?: string
  source?: {
    type: string
    repo_url?: string
    skill_path?: string
    imported_at?: string
  }
}

/**
 * Skipped skill information (not found, not from git, etc.)
 */
export interface GitBatchUpdateSkippedItem {
  id: number
  name?: string
  reason: string
}

/**
 * Failed skill update information
 */
export interface GitBatchUpdateFailedItem {
  id: number
  name?: string
  error: string
}

/**
 * Response from batch updating skills from Git repositories
 */
export interface GitBatchUpdateResponse {
  success: GitBatchUpdateSuccessItem[]
  skipped: GitBatchUpdateSkippedItem[]
  failed: GitBatchUpdateFailedItem[]
  total_success: number
  total_skipped: number
  total_failed: number
}

/**
 * Batch update multiple skills from their original Git repository sources.
 *
 * This function optimizes the update process by:
 * 1. Grouping skills by their source repository
 * 2. Downloading each repository only once
 * 3. Updating all skills from the same repository in a single pass
 *
 * This is more efficient than calling updateSkillFromGit for each skill individually,
 * especially when multiple skills come from the same repository.
 *
 * @param skillIds - Array of skill IDs to update
 * @returns GitBatchUpdateResponse with success, skipped, and failed lists
 */
export async function batchUpdateSkillsFromGit(
  skillIds: number[]
): Promise<GitBatchUpdateResponse> {
  const token = getToken()
  if (!token) throw new Error('No authentication token')

  const url = `${getApiUrl()}/v1/kinds/skills/git/batch-update`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ skill_ids: skillIds }),
  })

  if (!response.ok) {
    const error = await response.text()
    try {
      const json = JSON.parse(error)
      throw new Error(json.detail || 'Failed to batch update skills from Git')
    } catch {
      throw new Error(error || 'Failed to batch update skills from Git')
    }
  }

  return response.json()
}
