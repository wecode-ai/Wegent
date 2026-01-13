// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import { WikiProject, WikiGeneration } from '@/types/wiki'
import { GitRepoInfo, GitBranch } from '@/types/api'
import {
  fetchWikiProjects,
  createWikiGeneration,
  cancelWikiGeneration,
  fetchWikiGenerations,
  fetchWikiConfig,
  WikiConfigResponse,
} from '@/apis/wiki'
import { githubApis } from '@/apis/github'

interface UseWikiProjectsOptions {
  pageSize?: number
}

/**
 * Parse source type from git URL
 */
function parseSourceType(gitUrl: string): 'github' | 'gitlab' | 'gitee' | 'unknown' {
  const lowerUrl = gitUrl.toLowerCase()
  if (lowerUrl.includes('github.com') || lowerUrl.includes('github')) {
    return 'github'
  }
  if (lowerUrl.includes('gitlab') || lowerUrl.includes('git.')) {
    return 'gitlab'
  }
  if (lowerUrl.includes('gitee.com')) {
    return 'gitee'
  }
  return 'unknown'
}

/**
 * Extract domain from git URL (preserves protocol)
 *
 * Returns protocol + hostname (e.g., "https://github.com" or "http://gitlab.example.com")
 * This is important because the backend needs to know whether to use http or https
 * when making API requests to GitLab/GitHub servers.
 */
function extractDomain(gitUrl: string): string {
  try {
    const url = new URL(gitUrl)
    // Return protocol + hostname (e.g., "https://github.com")
    return `${url.protocol}//${url.hostname}`
  } catch {
    // Try to extract from git@ format (SSH URLs don't have protocol)
    const match = gitUrl.match(/@([^:]+):/)
    if (match) {
      // For SSH URLs, return just the hostname (backend will default to https)
      return match[1]
    }
    return ''
  }
}

export function useWikiProjects(options: UseWikiProjectsOptions = {}) {
  const { pageSize = 20 } = options

  // State
  const [projects, setProjects] = useState<(WikiProject & { generations?: WikiGeneration[] })[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cancellingIds, setCancellingIds] = useState<Set<number>>(new Set())

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const [hasMore, setHasMore] = useState(true)

  // Prevent duplicate requests
  const loadingRef = useRef(false)

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [selectedRepo, setSelectedRepo] = useState<GitRepoInfo | null>(null)
  const [selectedBranch, setSelectedBranch] = useState<GitBranch | null>(null)
  const [formData, setFormData] = useState({
    source_url: '',
    branch_name: '',
  })
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  // Wiki config state (system-level configuration)
  const [wikiConfig, setWikiConfig] = useState<WikiConfigResponse | null>(null)
  const [configLoading, setConfigLoading] = useState(false)

  // Confirm dialog state
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false)
  const [pendingCancelProjectId, setPendingCancelProjectId] = useState<number | null>(null)

  // Helper function to load generations for projects
  // Note: We don't pass accountId here because wiki generations are owned by the system user
  // (WIKI_DEFAULT_USER_ID). The backend will use the system-configured user ID to query generations.
  const loadProjectsWithGenerations = useCallback(async (projectItems: WikiProject[]) => {
    return Promise.all(
      projectItems.map(async project => {
        try {
          // Don't pass accountId - let backend use system-configured DEFAULT_USER_ID
          const generationsResponse = await fetchWikiGenerations(project.id, 1, 10)
          return {
            ...project,
            generations: generationsResponse.items,
          }
        } catch (err) {
          console.error(`Failed to load generations for project ${project.id}:`, err)
          return {
            ...project,
            generations: [],
          }
        }
      })
    )
  }, [])

  // Load projects with generations (initial load or refresh)
  const loadProjects = useCallback(async () => {
    if (loadingRef.current) return
    loadingRef.current = true

    try {
      setLoading(true)
      setCurrentPage(1)
      const response = await fetchWikiProjects(1, pageSize)

      const projectsWithGenerations = await loadProjectsWithGenerations(response.items)

      setProjects(projectsWithGenerations)
      setTotalCount(response.total)
      setHasMore(response.items.length < response.total)
      setError(null)
    } catch (err) {
      console.error('Failed to load wiki projects:', err)
      setError('Failed to load projects')
    } finally {
      setLoading(false)
      loadingRef.current = false
    }
  }, [pageSize, loadProjectsWithGenerations])

  // Load more projects (pagination)
  const loadMoreProjects = useCallback(async () => {
    if (loadingRef.current || !hasMore || loadingMore) return
    loadingRef.current = true

    try {
      setLoadingMore(true)
      const nextPage = currentPage + 1
      const response = await fetchWikiProjects(nextPage, pageSize)

      const projectsWithGenerations = await loadProjectsWithGenerations(response.items)

      setProjects(prev => [...prev, ...projectsWithGenerations])
      setCurrentPage(nextPage)
      setHasMore(projects.length + response.items.length < response.total)
    } catch (err) {
      console.error('Failed to load more wiki projects:', err)
    } finally {
      setLoadingMore(false)
      loadingRef.current = false
    }
  }, [currentPage, pageSize, hasMore, loadingMore, projects.length, loadProjectsWithGenerations])
  // Load wiki config on mount
  useEffect(() => {
    const loadWikiConfig = async () => {
      setConfigLoading(true)
      try {
        const config = await fetchWikiConfig()
        setWikiConfig(config)
      } catch (err) {
        console.error('Failed to load wiki config:', err)
      } finally {
        setConfigLoading(false)
      }
    }
    loadWikiConfig()
  }, [])

  // Open add repo modal
  const handleAddRepo = useCallback(() => {
    // Note: The check for bound model is now handled in the modal component
    // using the wikiConfig.has_bound_model flag
    setIsModalOpen(true)
    setSelectedRepo(null)
    setSelectedBranch(null)
    setFormData({
      source_url: '',
      branch_name: '',
    })
    setFormErrors({})
  }, [wikiConfig])

  // Close modal
  const handleCloseModal = useCallback(() => {
    setIsModalOpen(false)
    setSelectedRepo(null)
    setSelectedBranch(null)
    setFormErrors({})
  }, [])

  // Handle repo change from selector - automatically fetch and use default branch
  const handleRepoChange = useCallback(async (repo: GitRepoInfo | null) => {
    setSelectedRepo(repo)
    if (repo) {
      setFormData(prev => ({
        ...prev,
        source_url: repo.git_url,
      }))
      // Clear source_url error
      setFormErrors(prev => {
        const newErrors = { ...prev }
        delete newErrors.source_url
        return newErrors
      })

      // Fetch branches and auto-select default branch
      try {
        const branches = await githubApis.getBranches(repo)
        const defaultBranch = branches.find(b => b.default)
        if (defaultBranch) {
          setSelectedBranch(defaultBranch)
          setFormData(prev => ({
            ...prev,
            branch_name: defaultBranch.name,
          }))
          // Clear branch_name error
          setFormErrors(prev => {
            const newErrors = { ...prev }
            delete newErrors.branch_name
            return newErrors
          })
        } else if (branches.length > 0) {
          // Fallback to first branch if no default found
          setSelectedBranch(branches[0])
          setFormData(prev => ({
            ...prev,
            branch_name: branches[0].name,
          }))
        } else {
          // No branches available, use empty string to let git use repository's default branch
          setSelectedBranch(null)
          setFormData(prev => ({
            ...prev,
            branch_name: '',
          }))
        }
      } catch (error) {
        console.error('Failed to fetch branches:', error)
        // On error, use empty string to let git use repository's default branch
        setSelectedBranch(null)
        setFormData(prev => ({
          ...prev,
          branch_name: '',
        }))
      }
    } else {
      setSelectedBranch(null)
    }
  }, [])
  // Handle branch change from selector (kept for backward compatibility)
  const handleBranchChange = useCallback((branch: GitBranch | null) => {
    setSelectedBranch(branch)
    if (branch) {
      setFormData(prev => ({
        ...prev,
        branch_name: branch.name,
      }))
      // Clear branch_name error
      setFormErrors(prev => {
        const newErrors = { ...prev }
        delete newErrors.branch_name
        return newErrors
      })
    }
  }, [])

  // Handle form input change (for backward compatibility)
  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const { name, value } = e.target
      setFormData(prev => ({
        ...prev,
        [name]: value,
      }))

      if (formErrors[name]) {
        setFormErrors(prev => {
          const newErrors = { ...prev }
          delete newErrors[name]
          return newErrors
        })
      }
    },
    [formErrors]
  )

  // Submit form
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()

      // Check if wiki has bound model - this should be blocked by UI,
      // but double-check here as a safeguard
      if (wikiConfig && !wikiConfig.has_bound_model) {
        return
      }

      // Validate using selected repo (branch is auto-selected from default)
      const errors: Record<string, string> = {}
      if (!selectedRepo) {
        errors.source_url = 'Please select a repository'
      }

      if (Object.keys(errors).length > 0) {
        setFormErrors(errors)
        return
      }

      // Use selected branch name (already auto-selected from default branch)
      // When branch is empty, git will clone the repository's default branch
      const branchName = selectedBranch?.name || ''

      setIsSubmitting(true)

      try {
        const sourceUrl = selectedRepo!.git_url
        const sourceType = parseSourceType(sourceUrl)
        const sourceDomain = extractDomain(sourceUrl)

        // Note: team_id and model_id are no longer sent - they are configured in backend
        // Use system-configured language from wikiConfig
        const language = wikiConfig?.default_language || 'en'

        const requestData = {
          project_name: selectedRepo!.git_repo,
          source_url: sourceUrl,
          source_id: String(selectedRepo!.git_repo_id),
          source_domain: sourceDomain,
          project_type: 'git',
          source_type: sourceType,
          generation_type: 'full',
          language: language,
          source_snapshot: {
            type: 'git',
            branch_name: branchName,
            commit_id: '',
            commit_message: '',
            commit_time: new Date().toISOString(),
            commit_author: '',
            path: '',
            version: '',
            url: sourceUrl,
            snapshot_time: new Date().toISOString(),
            file_count: 0,
          },
          ext: {},
        }

        await createWikiGeneration(requestData)
        handleCloseModal()
        await loadProjects()
      } catch (err) {
        console.error('Failed to add repository:', err)
        // Extract error message from the error object
        let errorMessage = 'Failed to add repository, please try again'
        if (err instanceof Error && err.message) {
          errorMessage = err.message
        }
        setFormErrors({ submit: errorMessage })
      } finally {
        setIsSubmitting(false)
      }
    },
    [selectedRepo, selectedBranch, wikiConfig, handleCloseModal, loadProjects]
  )

  // Open cancel confirmation dialog
  const handleCancelClick = useCallback((projectId: number, e: React.MouseEvent) => {
    e.stopPropagation()
    setPendingCancelProjectId(projectId)
    setConfirmDialogOpen(true)
  }, [])

  // Confirm cancel generation
  const confirmCancelGeneration = useCallback(async () => {
    if (!pendingCancelProjectId) return

    const projectId = pendingCancelProjectId
    setConfirmDialogOpen(false)
    setPendingCancelProjectId(null)

    const project = projects.find(p => p.id === projectId)
    if (!project || !project.generations || project.generations.length === 0) {
      return
    }

    const activeGenerations = project.generations.filter(
      gen => gen.status === 'RUNNING' || gen.status === 'PENDING'
    )

    if (activeGenerations.length === 0) {
      return
    }

    const latestActiveGeneration = [...activeGenerations].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0]

    const generationId = latestActiveGeneration.id

    if (cancellingIds.has(generationId)) {
      return
    }

    setCancellingIds(prev => new Set(prev).add(generationId))

    try {
      await cancelWikiGeneration(generationId)
      await loadProjects()
    } catch (err) {
      console.error('Failed to cancel generation:', err)
    } finally {
      setCancellingIds(prev => {
        const newSet = new Set(prev)
        newSet.delete(generationId)
        return newSet
      })
    }
  }, [pendingCancelProjectId, projects, cancellingIds, loadProjects])

  return {
    // State
    projects,
    loading,
    loadingMore,
    error,
    cancellingIds,
    // Pagination state
    hasMore,
    totalCount,
    // Modal state
    isModalOpen,
    formData,
    formErrors,
    isSubmitting,
    selectedRepo,
    selectedBranch,
    // Wiki config state
    wikiConfig,
    configLoading,
    // Confirm dialog state
    confirmDialogOpen,
    pendingCancelProjectId,
    // Methods
    loadProjects,
    loadMoreProjects,
    handleAddRepo,
    handleCloseModal,
    handleInputChange,
    handleRepoChange,
    handleBranchChange,
    handleSubmit,
    handleCancelClick,
    confirmCancelGeneration,
    setConfirmDialogOpen,
    setPendingCancelProjectId,
  }
}
