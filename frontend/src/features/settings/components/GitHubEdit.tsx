'use client'

import React, { useState, useEffect } from 'react'
import Modal from '@/features/common/Modal'
import { Button } from 'antd'
import { useUser } from '@/features/common/UserContext'
import { App } from 'antd'
import { fetchGitInfo, saveGitToken } from '../services/github'
import { GitInfo } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'

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
  const { t } = useTranslation('common')
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
      message.error(t('github.error.required'))
      return
    }
    setTokenSaving(true)
    try {
      await saveGitToken(user, domainToSave, tokenToSave)
      onClose()
      await refresh()
    } catch (e: any) {
        message.error(e?.message || t('github.error.save_failed'))
      } finally {
        setTokenSaving(false)
      }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={mode === 'edit' && domain ? t('github.modal.title_edit') : t('github.modal.title_add')}
      maxWidth="md"
    >
      <div className="space-y-4">
        {/* 平台选择 */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            {t('github.platform')}
          </label>
          <div className="flex gap-4">
            <label className="flex items-center gap-1 text-sm text-text-primary">
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
              {t('github.platform_github')}
            </label>
            <label className="flex items-center gap-1 text-sm text-text-primary" title={t('github.platform_gitlab')}>
              <input
                type="radio"
                value="gitlab"
                checked={type === 'gitlab'}
                onChange={() => {
                  setType('gitlab')
                  setDomain('')
                }}
              />
              {t('github.platform_gitlab')}
            </label>
          </div>
        </div>
        {/* 域名输入 */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            {t('github.domain')}
          </label>
          <input
            type="text"
            value={type === 'github' ? 'github.com' : domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder={type === 'github' ? 'github.com' : 'e.g. gitlab.example.com'}
            className="w-full px-3 py-2 bg-base border border-border rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent"
            disabled={type === 'github'}
          />
        </div>
        {/* Token 输入 */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            {t('github.token.title')}
          </label>
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={type === 'github' ? t('github.token.placeholder_github') : t('github.token.placeholder_gitlab')}
            className="w-full px-3 py-2 bg-base border border-border rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent"
          />
        </div>
        {/* 获取指引 */}
        <div className="bg-surface border border-border rounded-md p-3">
          <p className="text-xs text-text-muted mb-2">
            <strong>
              {type === 'github'
                ? t('github.howto.github.title')
                : t('github.howto.gitlab.title')}
            </strong>
          </p>
          {type === 'github' ? (
            <>
              <p className="text-xs text-text-muted mb-2 flex items-center gap-1">
                {t('github.howto.step1_visit')}
                <a
                  href="https://github.com/settings/tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80 underline truncate max-w-[220px] inline-block align-bottom"
                  title="https://github.com/settings/tokens"
                >
                  https://github.com/settings/tokens
                </a>
              </p>
              <p className="text-xs text-text-muted mb-2">
                {t('github.howto.github.step2')}
              </p>
              <p className="text-xs text-text-muted">
                {t('github.howto.github.step3')}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-text-muted mb-2 flex items-center gap-1">
                {t('github.howto.step1_visit')}
                <a
                  href={type === 'gitlab' && domain.trim() ? `https://${domain.trim()}/-/profile/personal_access_tokens` : '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80 underline truncate max-w-[220px] inline-block align-bottom"
                  title={type === 'gitlab' && domain.trim()
                    ? `https://${domain.trim()}/-/profile/personal_access_tokens`
                    : 'your-gitlab-domain/-/profile/personal_access_tokens'}
                >
                  {type === 'gitlab' && domain.trim()
                    ? `https://${domain.trim()}/-/profile/personal_access_tokens`
                    : 'your-gitlab-domain/-/profile/personal_access_tokens'}
                </a>
              </p>
              <p className="text-xs text-text-muted mb-2">
                {t('github.howto.gitlab.step2')}
              </p>
              <p className="text-xs text-text-muted">
                {t('github.howto.gitlab.step3')}
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
          {t('common.cancel')}
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
          {tokenSaving ? t('github.saving') : t('github.save_token')}
        </Button>
      </div>
    </Modal>
  )
}

export default GitHubEdit
