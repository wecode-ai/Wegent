// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import '@/features/common/scrollbar.css'
import { Button } from '@/components/ui/button'
import { PencilIcon, TrashIcon } from '@heroicons/react/24/outline'
import { FiGithub, FiGitlab, FiGitBranch } from 'react-icons/fi'
import { SiGitea } from 'react-icons/si'
import GitHubEdit from './GitHubEdit'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'
import LoadingState from '@/features/common/LoadingState'
import { GitInfo } from '@/types/api'
import { useUser } from '@/features/common/UserContext'
import { fetchGitInfo, deleteGitToken } from '../services/github'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'

export default function GitHubIntegration() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { user, refresh } = useUser()
  const [gitInfo, setGitInfo] = useState<GitInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [modalType, setModalType] = useState<'add' | 'edit'>('add')
  const [currentEditInfo, setCurrentEditInfo] = useState<GitInfo | null>(null)

  useEffect(() => {
    async function loadGitInfo() {
      setIsLoading(true)
      try {
        if (user) {
          const info = await fetchGitInfo(user)
          setGitInfo(info)
        } else {
          // If no user, set empty array to show the "no tokens" state
          setGitInfo([])
        }
      } catch {
        toast({
          variant: 'destructive',
          title: t('common:integrations.loading'),
        })
        setGitInfo([])
      } finally {
        setIsLoading(false)
      }
    }
    loadGitInfo()
  }, [user, toast, t])

  const platforms = gitInfo || []

  const getMaskedTokenDisplay = (token: string) => {
    if (!token) return null
    if (token.length >= 8) {
      return (
        token.substring(0, 4) +
        '*'.repeat(Math.max(32, token.length - 8)) +
        token.substring(token.length - 4)
      )
    }
    return token
  }

  // Edit
  const handleEdit = (info: GitInfo) => {
    setModalType('edit')
    setCurrentEditInfo(info)
    setShowModal(true)
  }

  // Add
  const handleAdd = () => {
    setModalType('add')
    setCurrentEditInfo(null)
    setShowModal(true)
  }

  // Token deletion - uses git_info id for precise deletion
  const handleDelete = async (gitInfo: GitInfo) => {
    if (!user) return
    try {
      const success = await deleteGitToken(user, gitInfo)
      if (!success) {
        toast({
          variant: 'destructive',
          title: t('common:integrations.delete'),
        })
        return
      }
      await refresh()
    } catch {
      toast({
        variant: 'destructive',
        title: t('common:integrations.delete'),
      })
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-border bg-base p-4">
      <div className="space-y-1">
        <h3 className="text-base font-medium text-text-primary">
          {t('common:integrations.git_title')}
        </h3>
        <p className="text-sm text-text-muted">{t('common:integrations.git_description')}</p>
      </div>

      {isLoading ? (
        <LoadingState fullScreen={false} message={t('common:integrations.loading')} />
      ) : (
        <>
          {platforms.length > 0 && (
            <div className="space-y-2 max-h-[50vh] overflow-y-auto custom-scrollbar">
              {platforms.map((info, index) => (
                <div
                  key={info.id || `${info.git_domain}-${index}`}
                  className="flex items-center justify-between rounded-md border border-border/70 bg-surface px-3 py-2.5"
                >
                  <div className="flex items-center space-x-3 min-w-0 flex-1">
                    {info.type === 'gitlab' || info.type === 'gitee' ? (
                      <FiGitlab className="w-5 h-5 text-text-primary flex-shrink-0" />
                    ) : info.type === 'gitea' ? (
                      <SiGitea className="w-5 h-5 text-text-primary flex-shrink-0" />
                    ) : info.type === 'gerrit' ? (
                      <FiGitBranch className="w-5 h-5 text-text-primary flex-shrink-0" />
                    ) : (
                      <FiGithub className="w-5 h-5 text-text-primary flex-shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center">
                        <span className="text-sm font-medium text-text-primary truncate">
                          {info.git_domain}
                        </span>
                        {info.git_login && (
                          <span className="text-xs text-text-muted ml-2 flex-shrink-0">
                            ({info.git_login})
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-text-muted break-all font-mono">
                        {info.type === 'gerrit' && info.user_name ? `${info.user_name} | ` : ''}
                        {getMaskedTokenDisplay(info.git_token)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEdit(info)}
                      title={t('common:integrations.edit_token')}
                      className="h-8 w-8"
                      data-testid={`edit-git-token-${index}`}
                    >
                      <PencilIcon className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(info)}
                      title={t('common:integrations.delete')}
                      className="h-8 w-8 hover:text-error"
                      data-testid={`delete-git-token-${index}`}
                    >
                      <TrashIcon className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {platforms.length === 0 && (
            <div className="rounded-md border border-border/70 bg-surface px-3 py-4 text-center">
              <p className="text-sm text-text-muted">{t('common:integrations.no_tokens')}</p>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <UnifiedAddButton onClick={handleAdd} data-testid="add-git-token-button">
              {t('common:integrations.new_token')}
            </UnifiedAddButton>
          </div>
        </>
      )}

      <GitHubEdit
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        mode={modalType}
        editInfo={currentEditInfo}
      />
    </div>
  )
}
