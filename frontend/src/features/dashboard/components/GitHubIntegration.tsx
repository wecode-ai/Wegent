// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import '@/features/common/scrollbar.css'
import { Button } from '@headlessui/react'
import { PencilIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline'
import { FiGithub, FiGitlab } from 'react-icons/fi'
import Modal from '@/features/common/Modal'
import LoadingState from '@/features/common/LoadingState'
import { GitInfo } from '@/types/api'
import { useUser } from '@/features/common/UserContext'
import { fetchGitInfo, saveGitToken, deleteGitToken } from '../services/github'

export default function GitHubIntegration() {
  const { user, isLoading: isUserLoading, refresh } = useUser()
  const [gitInfo, setGitInfo] = useState<GitInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editDomain, setEditDomain] = useState<string>('')
  const [editToken, setEditToken] = useState('')
  const [editType, setEditType] = useState<'github' | 'gitlab'>('github')
  const [tokenSaving, setTokenSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    async function loadGitInfo() {
      setIsLoading(true)
      try {
        if (user) {
          const info = await fetchGitInfo(user)
          setGitInfo(info)
        }
      } catch (e) {
        setError('Failed to load git info')
      } finally {
        setIsLoading(false)
      }
    }
    loadGitInfo()
  }, [user])

  const platforms = gitInfo || []

  const getMaskedTokenDisplay = (token: string) => {
    if (!token) return null
    if (token.length >= 8) {
      return token.substring(0, 4) + '*'.repeat(Math.max(32, token.length - 8)) + token.substring(token.length - 4)
    }
    return token
  }

  const handleEdit = (domain?: string) => {
    if (domain) {
      const info = platforms.find(info => info.git_domain === domain)
      setEditDomain(domain)
      setEditToken(info?.git_token || '')
      setEditType(info?.type === 'gitlab' ? 'gitlab' : 'github')
    } else {
      setEditDomain('')
      setEditToken('')
      setEditType('github')
    }
    setShowModal(true)
    setError('')
  }

  const handleSave = async () => {
    if (!user) return; // Fix type issue
    const domainToSave = editType === 'github' ? 'github.com' : editDomain.trim()
    const tokenToSave = editToken.trim()
    if (!domainToSave || !tokenToSave) return
    setTokenSaving(true)
    setError('')
    try {
      await saveGitToken(user, domainToSave, tokenToSave)
      setShowModal(false)
      setEditDomain('')
      setEditToken('')
      await refresh()
    } catch (e) {
      setError('Failed to save token')
    } finally {
      setTokenSaving(false)
    }
  }

  const handleDelete = async (domain: string) => {
    if (!user) return; // Fix type issue
    setTokenSaving(true)
    setError('')
    try {
      const success = await deleteGitToken(user, domain)
      if (!success) setError('Delete failed')
      await refresh()
    } catch (e) {
      setError('Delete failed')
    } finally {
      setTokenSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-white mb-2">Integrations</h2>
        <p className="text-sm text-gray-400">Setting external services to enhance your workflow</p>
      </div>
      <div className="bg-[#161b22] border border-[#30363d] rounded-md p-4 space-y-3 max-h-[70vh] overflow-y-auto custom-scrollbar">
        {isUserLoading || isLoading ? (
          <LoadingState fullScreen={false} message="Loading Git integrations..." />
        ) : (
          <>
            {platforms.length > 0 ? (
              platforms.map((info) => (
                <div key={info.git_domain}>
                  <div className="flex items-center justify-between py-2">
                    <div className="flex items-center space-x-3 w-0 flex-1 min-w-0">
                      {info.type === 'gitlab' ? (
                        <FiGitlab className="w-4 h-4 text-orange-400" />
                      ) : (
                        <FiGithub className="w-4 h-4 text-white" />
                      )}
                      <div>
                        <div className="flex items-center space-x-2">
                          <h3 className="text-base font-medium text-white truncate">{info.git_domain}</h3>
                        </div>
                        <div>
                          <p className="text-xs text-gray-400 break-all font-mono">{getMaskedTokenDisplay(info.git_token)}</p>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center space-x-3">
                      <button
                        onClick={() => handleEdit(info.git_domain)}
                        className="p-1.5 text-gray-400 hover:text-white hover:bg-[#21262d] rounded transition-colors duration-200"
                        title="Edit Token"
                      >
                        <PencilIcon className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(info.git_domain)}
                        className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-red-900/20 rounded transition-colors duration-200"
                        title="Delete"
                      >
                        <TrashIcon className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  {platforms.length > 1 && info.git_domain !== platforms[platforms.length - 1].git_domain && (
                    <div className="border-t border-[#30363d] mt-3 pt-3"></div>
                  )}
                </div>
              ))
            ) : (
              <div className="text-center text-gray-500 py-4">
                <p className="text-sm">No git tokens configured</p>
              </div>
            )}
            <div className="border-t border-[#30363d]"></div>
            <div className="flex justify-center mt-4">
              <Button
                onClick={() => handleEdit('')}
                className="flex items-center space-x-1 px-3 py-1 text-xs font-medium text-gray-900 rounded transition-colors duration-200"
                style={{ backgroundColor: 'rgb(112,167,215)' }}
              >
                <PlusIcon className="w-3 h-3" />
                <span>New Token</span>
              </Button>
            </div>
          </>
        )}
      </div>
      <Modal
        isOpen={showModal}
        onClose={() => {
          setShowModal(false)
          setEditDomain('')
          setEditToken('')
          setError('')
        }}
        title={editDomain ? `Edit Token for ${editDomain}` : 'Add Git Token'}
        maxWidth="md"
      >
        <div className="space-y-4">
          {/* Platform Selection */}
          <div>
            <label className="block text-sm font-medium text-white mb-2">
              Git Platform
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-1 text-sm text-white">
                <input
                  type="radio"
                  value="github"
                  checked={editType === 'github'}
                  onChange={() => {
                    setEditType('github')
                    setEditDomain('github.com')
                  }}
                  disabled={!!editDomain && !!platforms.find(info => info.git_domain === editDomain)}
                />
                GitHub
              </label>
              <label className="flex items-center gap-1 text-sm text-white opacity-50 cursor-not-allowed" title="GitLab">
                <input
                  type="radio"
                  value="gitlab"
                  checked={editType === 'gitlab'}
                  onChange={() => {
                    setEditType('gitlab')
                    setEditDomain('')
                  }}
                  disabled={true}
                />
                GitLab(Incoming)
              </label>
            </div>
          </div>
          {/* Domain Input */}
          <div>
            <label className="block text-sm font-medium text-white mb-2">
              Git Platform Domain
            </label>
            <input
              type="text"
              value={editType === 'github' ? 'github.com' : editDomain}
              onChange={(e) => setEditDomain(e.target.value)}
              placeholder={editType === 'github' ? 'github.com' : 'e.g. gitlab.example.com'}
              className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-md text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent"
              disabled={editType === 'github' || (!!editDomain && !!platforms.find(info => info.git_domain === editDomain))}
            />
          </div>
          {/* Token Input */}
          <div>
            <label className="block text-sm font-medium text-white mb-2">
              Personal Access Token
            </label>
            <input
              type="password"
              value={editToken}
              onChange={(e) => setEditToken(e.target.value)}
              placeholder={editType === 'github' ? 'ghp_xxxxxxxxxxxxxxxxxxxx' : 'glpat-xxxxxxxxxxxxxxxxxxxx'}
              className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-md text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent"
            />
          </div>
          {error && (
            <div className="bg-red-900/20 border border-red-800/50 rounded-md p-3">
              <p className="text-xs text-red-300">{error}</p>
            </div>
          )}
          {/* Token Acquisition Guide */}
          <div className="bg-[#0d1117] border border-[#30363d] rounded-md p-3">
            <p className="text-xs text-gray-400 mb-2">
              <strong>
                {editType === 'github'
                  ? 'How to get your GitHub token:'
                  : 'How to get your GitLab token:'}
              </strong>
            </p>
            {editType === 'github' ? (
              <>
                <p className="text-xs text-gray-400 mb-2">
                  1. Visit{' '}
                  <a
                    href="https://github.com/settings/tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 underline"
                  >
                    https://github.com/settings/tokens
                  </a>
                </p>
                <p className="text-xs text-gray-400 mb-2">
                  2. Click "Generate new token (classic)"
                </p>
                <p className="text-xs text-gray-400">
                  3. Select appropriate scopes and copy the generated token
                </p>
              </>
            ) : (
              <>
                <p className="text-xs text-gray-400 mb-2">
                  1. Visit{' '}
                  <a
                    href={editDomain ? `https://${editDomain}/-/profile/personal_access_tokens` : '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300 underline"
                  >
                    {editDomain
                      ? `https://${editDomain}/-/profile/personal_access_tokens`
                      : 'your-gitlab-domain/-/profile/personal_access_tokens'}
                  </a>
                </p>
                <p className="text-xs text-gray-400 mb-2">
                  2. Click "Create personal access token"
                </p>
                <p className="text-xs text-gray-400">
                  3. Select appropriate scopes and copy the generated token
                </p>
              </>
            )}
          </div>
        </div>
        <div className="flex space-x-3 mt-6">
          <Button
            onClick={() => {
              setShowModal(false)
              setEditDomain('')
              setEditToken('')
              setError('')
            }}
            className="flex-1 px-2 py-1 text-xs bg-[#21262d] hover:bg-[#30363d] text-gray-300 border border-[#30363d] rounded transition-colors duration-200"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={
              (editType === 'gitlab' && !editDomain.trim()) ||
              !editToken.trim() ||
              tokenSaving
            }
            className="flex-1 px-2 py-1 text-xs font-medium text-gray-900 rounded transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              backgroundColor:
                ((editType === 'github' || editDomain.trim()) &&
                  editToken.trim() &&
                  !tokenSaving)
                  ? 'rgb(112,167,215)'
                  : '#6b7280'
            }}
          >
            {tokenSaving ? 'Saving...' : 'Save Token'}
          </Button>
        </div>
      </Modal>
    </div>
  )
}