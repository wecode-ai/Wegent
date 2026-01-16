// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { WikiProject, WikiGenerationDetail } from '@/types/wiki'

/**
 * Structure order type definition
 */
export interface ContentWriteSummary {
  structure_order: string[]
}

export interface ContentWrite {
  summary: ContentWriteSummary
}

/**
 * Parse source URL to identify source_type and source_domain
 *
 * source_domain includes protocol (e.g., "https://github.com", "http://gitlab.example.com")
 * to ensure backend uses correct protocol when making API requests.
 */
export const parseSourceUrl = (url: string) => {
  try {
    const parsedUrl = new URL(url)
    const hostname = parsedUrl.hostname
    const pathname = parsedUrl.pathname
    const protocol = parsedUrl.protocol // e.g., "http:" or "https:"

    // Identify source_type
    let source_type = 'git'
    if (hostname.includes('github')) {
      source_type = 'github'
    } else if (hostname.includes('gitlab') || hostname.includes('git.')) {
      source_type = 'gitlab'
    }

    // Identify source_domain with protocol (e.g., "https://github.com")
    const source_domain = `${protocol}//${hostname}`

    // Identify project_name (extract from path, show up to 2 levels)
    const pathParts = pathname.split('/').filter(part => part)
    let project_name = ''
    if (pathParts.length >= 2) {
      const secondLast = pathParts[pathParts.length - 2]
      let last = pathParts[pathParts.length - 1]
      if (last.endsWith('.git')) {
        last = last.slice(0, -4)
      }
      project_name = `${secondLast}/${last}`
    } else if (pathParts.length > 0) {
      project_name = pathParts[pathParts.length - 1]
      if (project_name.endsWith('.git')) {
        project_name = project_name.slice(0, -4)
      }
    }

    const source_id = ''

    return {
      source_type,
      source_domain,
      source_id,
      project_name,
    }
  } catch {
    return {
      source_type: 'git',
      source_domain: '',
      source_id: '',
      project_name: '',
    }
  }
}

/**
 * Get project display name (two-level directory)
 */
export const getProjectDisplayName = (project: WikiProject) => {
  const parsed = parseSourceUrl(project.source_url)
  const displayName = parsed.project_name || project.project_name

  if (displayName.includes('/')) {
    const parts = displayName.split('/')
    return { parts, hasSlash: true }
  }

  return { parts: [displayName], hasSlash: false }
}

/**
 * Get directory structure order
 */
export const getStructureOrder = (wikiDetail: WikiGenerationDetail | null) => {
  if (!wikiDetail?.ext || Object.keys(wikiDetail.ext).length === 0) {
    return []
  }

  const contentWrite = (wikiDetail.ext as Record<string, unknown>).content_write as
    | ContentWrite
    | undefined
  if (!contentWrite || !contentWrite.summary || !contentWrite.summary.structure_order) {
    return []
  }

  return contentWrite.summary.structure_order
}

/**
 * Sort contents by structure order
 */
export const getSortedContents = (wikiDetail: WikiGenerationDetail | null) => {
  if (!wikiDetail?.contents) return []

  const structureOrder = getStructureOrder(wikiDetail)
  if (structureOrder.length === 0) return wikiDetail.contents

  return [...wikiDetail.contents].sort((a, b) => {
    const aKey = `${a.type}: ${a.title}`
    const bKey = `${b.type}: ${b.title}`

    const aIndex = structureOrder.indexOf(aKey)
    const bIndex = structureOrder.indexOf(bKey)

    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex
    if (aIndex !== -1) return -1
    if (bIndex !== -1) return 1
    if (a.type !== b.type) return a.type.localeCompare(b.type)
    return a.title.localeCompare(b.title)
  })
}

/**
 * Form validation
 */
export const validateRepoForm = (formData: {
  source_url: string
  branch_name: string
  language: string
}) => {
  const errors: Record<string, string> = {}

  if (!formData.source_url.trim()) {
    errors.source_url = 'Repository URL is required'
  } else {
    try {
      new URL(formData.source_url)
    } catch {
      errors.source_url = 'Please enter a valid URL'
    }
  }

  if (!formData.branch_name.trim()) {
    errors.branch_name = 'Branch name is required'
  }

  return errors
}
