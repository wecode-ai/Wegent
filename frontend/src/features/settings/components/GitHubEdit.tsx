'use client'

import React, { useState, useEffect } from 'react'
import Modal from '@/features/common/Modal'
import { Button } from 'antd'
import { useUser } from '@/features/common/UserContext'
import { App } from 'antd'
import { fetchGitInfo, saveGitToken } from '../services/github'
import { GitInfo } from '@/types/api'

interface GitHubEditProps {
  isOpen: boolean
  onClose: () => void
  mode: 'add' | 'edit'
  editInfo: GitInfo | null
}

const GitHubEdit: React.FC<GitHubEditProps> = ({
  isOpen,
  onClose,
  mode,
  editInfo,
}) => {
  const { user, refresh } = useUser()
  const { message } = App.useApp()
  const [platforms, setPlatforms] = useState<GitInfo[]>([])
  const [domain, setDomain] = useState('')
  const [token, setToken] = useState('')
  const [type, setType] = useState<'github' | 'gitlab'>('github')
  const [tokenSaving, setTokenSaving] = useState(false)

  // Load platform info and reset form when modal opens
  useEffect(() => {
    if (isOpen && user) {
      fetchGitInfo(user).then((info) => setPlatforms(info))
      if (mode === 'edit' && editInfo) {
        setDomain(editInfo.git_domain)
        setToken(editInfo.git_token)
        setType(editInfo.type)
      } else {
        setDomain('')
        setToken('')
        setType('github')
      }
    }
  }, [isOpen, user, mode, editInfo])

  // Save logic
  const handleSave = async () => {
    if (!user) return
    const domainToSave = type === 'github' ? 'github.com' : domain.trim()
    const tokenToSave = token.trim()
    if (!domainToSave || !tokenToSave) {
      message.error('Please fill in all required fields')
      return
    }
    setTokenSaving(true)
    try {
      await saveGitToken(user, domainToSave, tokenToSave)
      onClose()
      await refresh()
    } catch (e: any) {
        message.error(e?.message || 'Save failed')
      } finally {
        setTokenSaving(false)
      }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={mode === 'edit' && domain ? `Edit Token` : 'Add Git Token'}
      maxWidth="md"
    >
      <div className="space-y-4">
        {/* 平台选择 */}
        <div>
          <label className="block text-sm font-medium text-white mb-2">
            Platform
          </label>
          <div className="flex gap-4">
            <label className="flex items-center gap-1 text-sm text-white">
              <input
                type="radio"
                value="github"
                checked={type === 'github'}
                onChange={() => {
                  setType('github')
                  setDomain('github.com')
                }}
                disabled={!!domain && !!platforms.find(info => info.git_domain === domain)}
              />
              GitHub
            </label>
            <label className="flex items-center gap-1 text-sm text-white" title="GitLab">
              <input
                type="radio"
                value="gitlab"
                checked={type === 'gitlab'}
                onChange={() => {
                  setType('gitlab')
                  setDomain('')
                }}
              />
              GitLab
            </label>
          </div>
        </div>
        {/* 域名输入 */}
        <div>
          <label className="block text-sm font-medium text-white mb-2">
            Platform Domain
          </label>
          <input
            type="text"
            value={type === 'github' ? 'github.com' : domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder={type === 'github' ? 'github.com' : 'e.g. gitlab.example.com'}
            className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-md text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent"
            disabled={type === 'github'}
          />
        </div>
        {/* Token 输入 */}
        <div>
          <label className="block text-sm font-medium text-white mb-2">
            Personal Access Token
          </label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={type === 'github' ? 'ghp_xxxxxxxxxxxxxxxxxxxx' : 'glpat-xxxxxxxxxxxxxxxxxxxx'}
            className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-md text-white placeholder-gray-400 focus:outline-none focus:outline-white/25 focus:border-transparent"
          />
        </div>
        {/* 获取指引 */}
        <div className="bg-[#0d1117] border border-[#30363d] rounded-md p-3">
          <p className="text-xs text-gray-400 mb-2">
            <strong>
              {type === 'github'
                ? 'How to get your GitHub token:'
                : 'How to get your GitLab token:'}
            </strong>
          </p>
          {type === 'github' ? (
            <>
              <p className="text-xs text-gray-400 mb-2 flex items-center gap-1">
                1. Visit
                <a
                  href="https://github.com/settings/tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300 underline truncate max-w-[220px] inline-block align-bottom"
                  title="https://github.com/settings/tokens"
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
              <p className="text-xs text-gray-400 mb-2 flex items-center gap-1">
                1. Visit
                <a
                  href={type === 'gitlab' && domain.trim() ? `https://${domain.trim()}/-/profile/personal_access_tokens` : '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300 underline truncate max-w-[220px] inline-block align-bottom"
                  title={type === 'gitlab' && domain.trim()
                    ? `https://${domain.trim()}/-/profile/personal_access_tokens`
                    : 'your-gitlab-domain/-/profile/personal_access_tokens'}
                >
                  {type === 'gitlab' && domain.trim()
                    ? `https://${domain.trim()}/-/profile/personal_access_tokens`
                    : 'your-gitlab-domain/-/profile/personal_access_tokens'}
                </a>
              </p>
              <p className="text-xs text-gray-400 mb-2">
                2. Click "Add new token"
              </p>
              <p className="text-xs text-gray-400">
                3. Select appropriate scopes and copy the generated token
              </p>
            </>
          )}
        </div>
      </div>
      {/* 底部按钮区 */}
      <div className="flex space-x-3 mt-6">
        <Button
          onClick={onClose}
          type="default"
          size="small"
          style={{ flex: 1 }}
        >
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={
            (type === 'gitlab' && !domain.trim()) ||
            !token.trim() ||
            tokenSaving
          }
          type="primary"
          size="small"
          loading={tokenSaving}
          style={{ flex: 1 }}
        >
          {tokenSaving ? 'Saving...' : 'Save Token'}
        </Button>
      </div>
    </Modal>
  )
}

export default GitHubEdit