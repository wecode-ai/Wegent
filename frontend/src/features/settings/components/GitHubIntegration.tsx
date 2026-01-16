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
    <div className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">
          {t('common:integrations.title')}
        </h2>
        <p className="text-sm text-text-muted mb-1">{t('common:integrations.description')}</p>
      </div>
      <div className="bg-base border border-border rounded-md p-2 space-y-1 max-h-[70vh] overflow-y-auto custom-scrollbar w-full">
        {isLoading ? (
          <LoadingState fullScreen={false} message={t('common:integrations.loading')} />
        ) : (
          <>
            {platforms.length > 0 ? (
              platforms.map((info, index) => (
                <div key={info.id || `${info.git_domain}-${index}`}>
                  <div className="flex items-center justify-between py-0.5">
                    <div className="flex items-center space-x-2 w-0 flex-1 min-w-0">
                      {info.type === 'gitlab' || info.type === 'gitee' ? (
                        <FiGitlab className="w-4 h-4 text-text-primary" />
                      ) : info.type === 'gitea' ? (
                        <SiGitea className="w-4 h-4 text-text-primary" />
                      ) : info.type === 'gerrit' ? (
                        <FiGitBranch className="w-4 h-4 text-text-primary" />
                      ) : (
                        <FiGithub className="w-4 h-4 text-text-primary" />
                      )}
                      <div>
                        <div className="flex items-center space-x-1">
                          <h3 className="text-base font-medium text-text-primary truncate mb-0">
                            {info.git_domain}
                            {info.git_login && (
                              <span className="text-xs text-text-muted ml-2">
                                ({info.git_login})
                              </span>
                            )}
                          </h3>
                        </div>
                        <div>
                          <p className="text-xs text-text-muted break-all font-mono mt-0">
                            {info.type === 'gerrit' && info.user_name ? `${info.user_name} | ` : ''}
                            {getMaskedTokenDisplay(info.git_token)}
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleEdit(info)}
                        title={t('common:integrations.edit_token')}
                        className="h-8 w-8"
                      >
                        <PencilIcon className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleDelete(info)}
                        title={t('common:integrations.delete')}
                        className="h-8 w-8 hover:text-error"
                      >
                        <TrashIcon className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                  {index < platforms.length - 1 && (
                    <div className="border-t border-border mt-1 pt-1" />
                  )}
                </div>
              ))
            ) : (
              <div className="text-center text-text-muted py-4">
                <p className="text-sm">{t('common:integrations.no_tokens')}</p>
              </div>
            )}
            <div className="border-t border-border"></div>
            <div className="flex justify-center">
              <UnifiedAddButton onClick={handleAdd}>
                {t('common:integrations.new_token')}
              </UnifiedAddButton>
            </div>
          </>
        )}
      </div>
      <GitHubEdit
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        mode={modalType}
        editInfo={currentEditInfo}
      />
    </div>
  )
}
