// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState, useEffect, useMemo } from 'react'
import Modal from '@/features/common/Modal'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { useUser } from '@/features/common/UserContext'
import { fetchGitInfo, saveGitToken } from '../services/github'
import { GitInfo } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'

interface GitHubEditProps {
  isOpen: boolean
  onClose: () => void
  mode: 'add' | 'edit'
  editInfo: GitInfo | null
}

const sanitizeDomainInput = (value: string) => {
  if (!value) return ''
  const trimmed = value.trim()
  if (!trimmed) return ''

  // Check if it starts with http:// or https://
  const httpMatch = trimmed.match(/^(https?:\/\/)/i)
  const protocol = httpMatch ? httpMatch[1].toLowerCase() : ''

  // Remove protocol for processing
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, '')

  // Get domain only (remove path)
  const domainOnly = withoutProtocol.split('common:/')[0]

  // Return with protocol if it was http://, otherwise return domain only
  return protocol === 'http://'
    ? `http://${domainOnly.trim().toLowerCase()}`
    : domainOnly.trim().toLowerCase()
}

const isValidDomain = (value: string) => {
  if (!value) return false

  // Extract domain without protocol
  const domainWithoutProtocol = value.replace(/^https?:\/\//i, '')
  const [host, port] = domainWithoutProtocol.split(':')

  if (!host) return false
  if (port !== undefined) {
    if (!/^\d{1,5}$/.test(port)) return false
    const portNumber = Number(port)
    if (portNumber < 1 || portNumber > 65535) return false
  }
  if (host === 'localhost') return true
  const domainRegex = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(?:\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/
  return domainRegex.test(host)
}

const GitHubEdit: React.FC<GitHubEditProps> = ({ isOpen, onClose, mode, editInfo }) => {
  const { user, refresh } = useUser()
  const { t } = useTranslation()
  const { toast } = useToast()
  const [platforms, setPlatforms] = useState<GitInfo[]>([])
  const [domain, setDomain] = useState('')
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')
  const [type, setType] = useState<GitInfo['type']>('github')
  const [authType, setAuthType] = useState<'digest' | 'basic'>('digest')
  const [tokenSaving, setTokenSaving] = useState(false)
  const isGitlabLike = type === 'gitlab' || type === 'gitee'
  const isGitea = type === 'gitea'
  const isGerrit = type === 'gerrit'

  const isDomainInvalid = useMemo(() => {
    if (!domain) return false
    return !isValidDomain(domain)
  }, [domain])

  const domainLink = useMemo(() => {
    if (!domain) return ''
    return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`
  }, [domain])

  const giteaSettingsLink = useMemo(() => {
    const base = domainLink || 'https://gitea.com'
    return `${base.replace(/\/$/, '')}/user/settings/applications`
  }, [domainLink])

  const hasGithubPlatform = useMemo(
    () => platforms.some((info: GitInfo) => sanitizeDomainInput(info.git_domain) === 'github.com'),
    [platforms]
  )

  // Load platform info and reset form when modal opens
  useEffect(() => {
    if (isOpen && user) {
      fetchGitInfo(user).then(info => setPlatforms(info))
      if (mode === 'edit' && editInfo) {
        const sanitizedDomain = sanitizeDomainInput(editInfo.git_domain)
        setDomain(sanitizedDomain)
        setToken(editInfo.git_token)
        setUsername(editInfo.user_name || '')
        setType(editInfo.type)
        setAuthType(editInfo.auth_type || 'digest')
      } else {
        // For add mode, default to github.com when type is github
        setDomain('github.com')
        setToken('')
        setUsername('')
        setType('github')
        setAuthType('digest')
      }
    }
  }, [isOpen, user, mode, editInfo])

  // Save logic
  const handleSave = async () => {
    if (!user) return
    const sanitizedDomain = sanitizeDomainInput(domain)
    const domainToSave = sanitizedDomain || (type === 'github' ? 'github.com' : '')
    const tokenToSave = token.trim()
    const usernameToSave = username.trim()

    if (!domainToSave || !tokenToSave) {
      toast({
        variant: 'destructive',
        title: t('common:github.error.required'),
      })
      return
    }

    // Gerrit and Gitea require username
    if ((isGerrit || isGitea) && !usernameToSave) {
      const platformName = isGerrit ? 'Gerrit' : 'Gitea'
      toast({
        variant: 'destructive',
        title: `${platformName} username is required`,
      })
      return
    }

    if (!isValidDomain(domainToSave)) {
      toast({
        variant: 'destructive',
        title: t('common:github.error.invalid_domain'),
      })
      setDomain(sanitizedDomain)
      return
    }
    setTokenSaving(true)
    try {
      // Pass existing id when editing to update instead of create new record
      const existingId = mode === 'edit' && editInfo?.id ? editInfo.id : undefined
      // Pass authType for Gerrit
      const authTypeToSave = isGerrit ? authType : undefined
      await saveGitToken(
        user,
        domainToSave,
        tokenToSave,
        usernameToSave,
        type,
        existingId,
        authTypeToSave
      )
      onClose()
      await refresh()
    } catch (error) {
      toast({
        variant: 'destructive',
        title: (error as Error)?.message || t('common:github.error.save_failed'),
      })
    } finally {
      setTokenSaving(false)
    }
  }
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        mode === 'edit' && domain
          ? t('common:github.modal.title_edit')
          : t('common:github.modal.title_add')
      }
      maxWidth="md"
    >
      <div className="space-y-4">
        {/* Platform selection */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            {t('common:github.platform')}
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
                disabled={mode === 'edit' && editInfo?.type !== 'github' && hasGithubPlatform}
              />
              {t('common:github.platform_github')}
            </label>
            <label
              className="flex items-center gap-1 text-sm text-text-primary"
              title={t('common:github.platform_gitlab')}
            >
              <input
                type="radio"
                value="gitlab"
                checked={type === 'gitlab'}
                onChange={() => {
                  setType('gitlab')
                  setDomain('')
                }}
              />
              {t('common:github.platform_gitlab')}
            </label>
            <label
              className="flex items-center gap-1 text-sm text-text-primary"
              title={t('common:github.platform_gitea') || 'Gitea'}
            >
              <input
                type="radio"
                value="gitea"
                checked={isGitea}
                onChange={() => {
                  setType('gitea')
                  setDomain('gitea.com')
                }}
              />
              {t('common:github.platform_gitea') || 'Gitea'}
            </label>
            <label
              className="flex items-center gap-1 text-sm text-text-primary"
              title={t('common:github.platform_gerrit') || 'Gerrit'}
            >
              <input
                type="radio"
                value="gerrit"
                checked={isGerrit}
                onChange={() => {
                  setType('gerrit')
                  setDomain('')
                }}
              />
              {t('common:github.platform_gerrit') || 'Gerrit'}
            </label>
          </div>
        </div>
        {/* Domain input */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            {t('common:github.domain')}
          </label>
          <input
            type="text"
            value={domain}
            onChange={e => setDomain(e.target.value)}
            onBlur={e => setDomain(sanitizeDomainInput(e.target.value))}
            placeholder={
              type === 'github'
                ? 'e.g. github.com or github.enterprise.com'
                : isGerrit
                  ? 'e.g. http://gerrit.company.com or gerrit.company.com'
                  : isGitea
                    ? 'e.g. gitea.com or gitea.company.com'
                    : 'e.g. http://gitlab.example.com or gitlab.example.com'
            }
            className="w-full px-3 py-2 bg-base border border-border rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent"
          />
          {isDomainInvalid && (
            <p className="mt-1 text-xs text-red-500">{t('common:github.error.invalid_domain')}</p>
          )}
        </div>
        {/* Username input (Gerrit and Gitea only) */}
        {(isGerrit || isGitea) && (
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-2">
              {t('common:github.username') || 'Username'}
            </label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder={t('common:github.username') || 'Username'}
              className="w-full px-3 py-2 bg-base border border-border rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent"
            />
          </div>
        )}
        {/* Authentication type selection (Gerrit only) */}
        {isGerrit && (
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-2">
              {t('common:github.auth_type') || 'Authentication Method'}
            </label>
            <div className="flex gap-4">
              <label className="flex items-center gap-1 text-sm text-text-primary">
                <input
                  type="radio"
                  name="authType"
                  value="digest"
                  checked={authType === 'digest'}
                  onChange={() => setAuthType('digest')}
                />
                {t('common:github.auth_type_digest') || 'Digest Auth'}
              </label>
              <label className="flex items-center gap-1 text-sm text-text-primary">
                <input
                  type="radio"
                  name="authType"
                  value="basic"
                  checked={authType === 'basic'}
                  onChange={() => setAuthType('basic')}
                />
                {t('common:github.auth_type_basic') || 'Basic Auth'}
              </label>
            </div>
          </div>
        )}
        {/* Token input */}
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-2">
            {isGerrit
              ? t('common:github.token.title_gerrit') || 'HTTP password'
              : t('common:github.token.title')}
          </label>
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder={
              type === 'github'
                ? t('common:github.token.placeholder_github')
                : isGerrit
                  ? t('common:github.token.placeholder_gerrit') ||
                    'HTTP password from Gerrit Settings'
                  : isGitea
                    ? t('common:github.token.placeholder_gitea') || 'Gitea personal access token'
                    : t('common:github.token.placeholder_gitlab')
            }
            className="w-full px-3 py-2 bg-base border border-border rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-transparent"
          />
        </div>
        {/* Get guidance */}
        <div className="bg-surface border border-border rounded-md p-3">
          <p className="text-xs text-text-muted mb-2">
            <strong>
              {type === 'github'
                ? t('common:github.howto.github.title')
                : isGitea
                  ? t('common:github.howto.gitea.title') || 'How to get your Gitea token:'
                  : isGerrit
                    ? t('common:github.howto.gerrit.title') || 'How to get Gerrit HTTP password:'
                    : t('common:github.howto.gitlab.title')}
            </strong>
          </p>
          {type === 'github' ? (
            <>
              <p className="text-xs text-text-muted mb-2 flex items-center gap-1">
                {t('common:github.howto.step1_visit')}
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
                {t('common:github.howto.github.step2')}
              </p>
              <p className="text-xs text-text-muted">{t('common:github.howto.github.step3')}</p>
            </>
          ) : isGitea ? (
            <>
              <p className="text-xs text-text-muted mb-2 flex items-center gap-1">
                {t('common:github.howto.step1_visit')}
                <a
                  href={giteaSettingsLink || '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80 underline truncate max-w-[220px] inline-block align-bottom"
                  title={
                    giteaSettingsLink || 'https://gitea.example.com/user/settings/applications'
                  }
                >
                  {giteaSettingsLink || 'https://gitea.example.com/user/settings/applications'}
                </a>
              </p>
              <p className="text-xs text-text-muted mb-2">{t('common:github.howto.gitea.step2')}</p>
              <p className="text-xs text-text-muted mb-2">{t('common:github.howto.gitea.step3')}</p>
              <p className="text-xs text-warning">{t('common:github.howto.gitea.step4')}</p>
            </>
          ) : isGerrit ? (
            <>
              <p className="text-xs text-text-muted mb-2 flex items-center gap-1">
                {t('common:github.howto.step1_visit') || 'Visit: '}
                <a
                  href={isGerrit && domain ? `https://${domain}/settings/#HTTPCredentials` : '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80 underline truncate max-w-[220px] inline-block align-bottom"
                  title={
                    isGerrit && domain
                      ? `https://${domain}/settings/#HTTPCredentials`
                      : 'your-gerrit-domain/settings/#HTTPCredentials'
                  }
                >
                  {isGerrit && domain
                    ? `https://${domain}/settings/#HTTPCredentials`
                    : 'your-gerrit-domain/settings/#HTTPCredentials'}
                </a>
              </p>
              <p className="text-xs text-text-muted mb-2">
                {t('common:github.howto.gerrit.step2') ||
                  'Generate a new HTTP password under "HTTP Credentials"'}
              </p>
              <p className="text-xs text-text-muted">
                {t('common:github.howto.gerrit.step3') ||
                  'Copy the username and password, and paste them here'}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-text-muted mb-2 flex items-center gap-1">
                {t('common:github.howto.step1_visit')}
                <a
                  href={
                    isGitlabLike && domain
                      ? `https://${domain}/-/profile/personal_access_tokens`
                      : '#'
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80 underline truncate max-w-[220px] inline-block align-bottom"
                  title={
                    isGitlabLike && domain
                      ? `https://${domain}/-/profile/personal_access_tokens`
                      : 'your-gitlab-domain/-/profile/personal_access_tokens'
                  }
                >
                  {isGitlabLike && domain
                    ? `https://${domain}/-/profile/personal_access_tokens`
                    : 'your-gitlab-domain/-/profile/personal_access_tokens'}
                </a>
              </p>
              <p className="text-xs text-text-muted mb-2">
                {t('common:github.howto.gitlab.step2')}
              </p>
              <p className="text-xs text-text-muted">{t('common:github.howto.gitlab.step3')}</p>
            </>
          )}
        </div>
      </div>
      {/* Bottom button area */}
      <div className="flex space-x-3 mt-6">
        <Button onClick={onClose} variant="outline" size="sm" style={{ flex: 1 }}>
          {t('common:common.cancel')}
        </Button>
        <Button
          onClick={handleSave}
          disabled={
            !domain ||
            isDomainInvalid ||
            ((isGerrit || isGitea) && !username.trim()) ||
            !token.trim() ||
            tokenSaving
          }
          variant="primary"
          size="sm"
          style={{ flex: 1 }}
        >
          {tokenSaving ? t('common:github.saving') : t('common:github.save_token')}
        </Button>
      </div>
    </Modal>
  )
}

export default GitHubEdit
