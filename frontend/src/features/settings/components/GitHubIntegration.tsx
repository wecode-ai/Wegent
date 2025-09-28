// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import '@/features/common/scrollbar.css'
import { Button } from 'antd'
import { PencilIcon, PlusIcon, TrashIcon } from '@heroicons/react/24/outline'
import { FiGithub, FiGitlab } from 'react-icons/fi'
import Modal from '@/features/common/Modal'
import GitHubEdit from './GitHubEdit'
import LoadingState from '@/features/common/LoadingState'
import { GitInfo } from '@/types/api'
import { useUser } from '@/features/common/UserContext'
import { fetchGitInfo, saveGitToken, deleteGitToken } from '../services/github'
import { App } from 'antd'
import { useTranslation } from '@/hooks/useTranslation'

export default function GitHubIntegration() {
  const { t } = useTranslation('common')
  const { message } = App.useApp()
  const { user, isLoading: isUserLoading, refresh } = useUser()
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
      } catch (e) {
        message.error(t('integrations.loading'))
        setGitInfo([])
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

  // Token deletion logic unchanged

  const handleDelete = async (domain: string) => {
    if (!user) return; // Fix type issue
    // Unified error prompt using antd message.error, no local error state needed
    try {
      const success = await deleteGitToken(user, domain)
      if (!success) message.error(t('integrations.delete'))
      await refresh()
    } catch (e) {
      message.error(t('integrations.delete'))
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold text-text-primary mb-1">{t('integrations.title')}</h2>
        <p className="text-sm text-text-muted mb-1">{t('integrations.description')}</p>
      </div>
      <div className="bg-surface border border-border rounded-md p-2 space-y-1 max-h-[70vh] overflow-y-auto custom-scrollbar w-full">
        {isLoading ? (
          <LoadingState fullScreen={false} message={t('integrations.loading')} />
        ) : (
          <>
            {platforms.length > 0 ? (
              platforms.map((info) => (
                <div key={info.git_domain}>
                  <div className="flex items-center justify-between py-0.5">
                    <div className="flex items-center space-x-2 w-0 flex-1 min-w-0">
                      {info.type === 'gitlab' ? (
                        <FiGitlab className="w-4 h-4 text-text-primary" />
                      ) : (
                        <FiGithub className="w-4 h-4 text-text-primary" />
                      )}
                      <div>
                        <div className="flex items-center space-x-1">
                          <h3 className="text-base font-medium text-text-primary truncate mb-0">{info.git_domain}</h3>
                        </div>
                        <div>
                          <p className="text-xs text-text-muted break-all font-mono mt-0">{getMaskedTokenDisplay(info.git_token)}</p>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Button
                        type="text"
                        size="small"
                        icon={<PencilIcon className="w-4 h-4 text-text-muted" />}
                        onClick={() => handleEdit(info)}
                        title={t('integrations.edit_token')}
                        style={{ padding: '4px' }}
                        className="!text-text-muted hover:!text-text-primary"
                      />
                      <Button
                        type="text"
                        size="small"
                        icon={<TrashIcon className="w-4 h-4 text-text-muted" />}
                        onClick={() => handleDelete(info.git_domain)}
                        title={t('integrations.delete')}
                        style={{ padding: '4px' }}
                        className="!text-text-muted hover:!text-text-primary"
                      />
                    </div>
                  </div>
                  {platforms.length > 1 && info.git_domain !== platforms[platforms.length - 1].git_domain && (
                    <div className="border-t border-border mt-1 pt-1"></div>
                  )}
                </div>
              ))
            ) : (
              <div className="text-center text-text-muted py-4">
                <p className="text-sm">{t('integrations.no_tokens')}</p>
              </div>
            )}
            <div className="border-t border-border"></div>
            <div className="flex justify-center">
              <Button
                onClick={handleAdd}
                type="primary"
                size="small"
                icon={<PlusIcon className="h-4 w-4 align-middle" />}
                style={{ margin: '8px 0' }}
                className="!text-base"
              >
                {t('integrations.new_token')}
              </Button>
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
