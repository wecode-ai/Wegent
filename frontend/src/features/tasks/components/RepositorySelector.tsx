// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useMemo, useRef } from 'react'
import { Listbox } from '@headlessui/react'
import { ChevronDownIcon } from '@heroicons/react/24/outline'
import { FiGithub, FiSearch } from 'react-icons/fi'
import { GitRepoInfo } from '@/types/api'

interface RepositorySelectorProps {
  selectedRepo: GitRepoInfo | null
  handleRepoChange: (repo: GitRepoInfo) => void
  disabled: boolean
}

import { useEffect } from 'react'
import { githubApis } from '@/apis/github'

export default function RepositorySelector({
  selectedRepo,
  handleRepoChange,
  disabled
}: RepositorySelectorProps) {
  const [repos, setRepos] = useState<GitRepoInfo[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const searchTimeout = useRef<NodeJS.Timeout | null>(null)

  // Dropdown expansion direction
  const [dropdownDirection, setDropdownDirection] = useState<'up' | 'down'>('down')
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Calculate dropdown expansion direction
  const handleDropdownClick = () => {
    if (!buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    // If there is insufficient space below 320px (dropdown max height + margin), expand upward, otherwise downward
    if (spaceBelow < 100 && spaceAbove > spaceBelow) {
      setDropdownDirection('up')
    } else {
      setDropdownDirection('down')
    }
  }

  // Fetch initial repository list
  useEffect(() => {
    let ignore = false
    setLoading(true)
    githubApis.getRepositories()
      .then((data) => {
        if (!ignore) {
          setRepos(data)
          setError(null)
          // Select the first repository by default
          if (data.length > 0 && !selectedRepo) {
            handleRepoChange(data[0])
          }
        }
      })
      .catch((err) => {
        if (!ignore) setError('Failed to load repositories')
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => { ignore = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Remote search repositories (debounced)
  useEffect(() => {
    if (searchTimeout.current) {
      clearTimeout(searchTimeout.current)
    }
    if (!searchQuery) {
      // When search box is cleared, restore initial repository list
      setLoading(true)
      githubApis.getRepositories()
        .then((data) => {
          setRepos(data)
          setError(null)
        })
        .catch(() => setError('Failed to load repositories'))
        .finally(() => setLoading(false))
      return
    }
    setLoading(true)
    searchTimeout.current = setTimeout(() => {
      githubApis.searchRepositories(searchQuery)
        .then((data) => {
          setRepos(data)
          setError(null)
        })
        .catch(() => setError('Failed to search repositories'))
        .finally(() => setLoading(false))
    }, 300)
    return () => {
      if (searchTimeout.current) clearTimeout(searchTimeout.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery])

  // After remote search, use repos directly without local filtering
  const filteredRepos = repos

  // Always return only one Listbox, merge all states
  const showLoading = loading
  const showError = !!error
  const showNoRepo = !showLoading && !showError && repos.length === 0

  // Do not render when no item is selected and there are no repositories
  if (!selectedRepo && repos.length === 0 && !showLoading && !showError) return null

  return (
    <Listbox value={selectedRepo} onChange={handleRepoChange} disabled={disabled || showLoading || showError || showNoRepo}>
      <div className="relative">
        <Listbox.Button
          ref={buttonRef}
          className={`flex items-center space-x-1 text-gray-500 hover:text-gray-400 w-full ${disabled || showLoading || showError || showNoRepo ? 'opacity-50 cursor-not-allowed' : ''}`}
          onClick={handleDropdownClick}
        >
          <FiGithub className={`w-3 h-3 flex-shrink-0 ${showLoading ? 'animate-pulse' : ''}`} />
          <span className="text-sm truncate max-w-[100px]" title={selectedRepo?.git_repo || ''}>
            {showLoading
              ? 'Loading...'
              : showError
                ? 'Load failed'
                : showNoRepo
                  ? 'No repositories'
                  : selectedRepo?.git_repo}
          </span>
          <ChevronDownIcon className="w-4 h-4 flex-shrink-0" />
        </Listbox.Button>
        <Listbox.Options
          className={`absolute ${dropdownDirection === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'} left-0 bg-[#161b22] border border-[#30363d] rounded-lg shadow-xl z-20 min-w-full w-auto max-w-[220px] py-1 max-h-[300px] overflow-y-auto custom-scrollbar`}
        >
          {/* Search input */}
          <div className="sticky top-0 bg-[#161b22] border-b border-[#30363d]">
            <div className="relative">
              <FiSearch className="absolute left-2 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
              <input
                type="text"
                placeholder="Search repositories..."
                className="w-full bg-[#0d1117] border-0 rounded px-8 py-1.5 text-sm text-white placeholder-gray-400 focus:outline-none"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                disabled={showLoading || showError || showNoRepo}
              />
            </div>
          </div>
          {/* Status and repository list */}
          {showLoading && (
            <div className="px-3 py-2 text-sm text-gray-400 flex items-center">
              <FiGithub className="w-4 h-4 animate-pulse mr-2" />
              Loading repositories...
            </div>
          )}
          {showError && (
            <div className="px-3 py-2 text-sm text-red-400 flex items-center">
              <FiGithub className="w-4 h-4 mr-2" />
              {error}
            </div>
          )}
          {showNoRepo && (
            <div className="px-3 py-2 text-sm text-gray-400">
              No repositories found
            </div>
          )}
          {!showLoading && !showError && filteredRepos.length > 0 && (
            filteredRepos.map((repo) => (
              <Listbox.Option
                key={repo.git_repo_id}
                value={repo}
                className="px-2.5 py-1.5 text-xs text-white hover:bg-[#21262d] cursor-pointer block truncate"
                title={repo.git_repo}
              >
                {repo.git_repo}
              </Listbox.Option>
            ))
          )}
        </Listbox.Options>
      </div>
    </Listbox>
  )
}