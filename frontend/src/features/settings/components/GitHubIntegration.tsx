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

export default function GitHubIntegration() {
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
        }
      } catch (e) {
        message.error('Failed to load git info')
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

  // 编辑
  const handleEdit = (info: GitInfo) => {
    setModalType('edit')
    setCurrentEditInfo(info)
    setShowModal(true)
  }

  // 新增
  const handleAdd = () => {
    setModalType('add')
    setCurrentEditInfo(null)
    setShowModal(true)
  }

  // 删除 token 逻辑不变

  const handleDelete = async (domain: string) => {
    if (!user) return; // Fix type issue
    // 已用 antd message.error 统一错误提示，无需本地 error 状态
    try {
      const success = await deleteGitToken(user, domain)
      if (!success) message.error('Delete failed')
      await refresh()
    } catch (e) {
      message.error('Delete failed')
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold text-white mb-1">Integrations</h2>
        <p className="text-sm text-gray-400 mb-1">Setting external services to enhance your workflow</p>
      </div>
      <div className="bg-[#161b22] border border-[#30363d] rounded-md p-2 space-y-1 max-h-[70vh] overflow-y-auto custom-scrollbar">
        {isUserLoading || isLoading ? (
          <LoadingState fullScreen={false} message="Loading Git integrations..." />
        ) : (
          <>
            {platforms.length > 0 ? (
              platforms.map((info) => (
                <div key={info.git_domain}>
                  <div className="flex items-center justify-between py-0.5">
                    <div className="flex items-center space-x-2 w-0 flex-1 min-w-0">
                      {info.type === 'gitlab' ? (
                        <FiGitlab className="w-4 h-4 text-white" />
                      ) : (
                        <FiGithub className="w-4 h-4 text-white" />
                      )}
                      <div>
                        <div className="flex items-center space-x-1">
                          <h3 className="text-base font-medium text-white truncate mb-0">{info.git_domain}</h3>
                        </div>
                        <div>
                          <p className="text-xs text-gray-400 break-all font-mono mt-0">{getMaskedTokenDisplay(info.git_token)}</p>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Button
                        type="text"
                        size="small"
                        icon={<PencilIcon className="w-4 h-4 text-gray-400" />}
                        onClick={() => handleEdit(info)}
                        title="Edit Token"
                        style={{ padding: '4px' }}
                      />
                      <Button
                        type="text"
                        size="small"
                        icon={<TrashIcon className="w-4 h-4 text-gray-400" />}
                        onClick={() => handleDelete(info.git_domain)}
                        title="Delete"
                        style={{ padding: '4px' }}
                      />
                    </div>
                  </div>
                  {platforms.length > 1 && info.git_domain !== platforms[platforms.length - 1].git_domain && (
                    <div className="border-t border-[#30363d] mt-1 pt-1"></div>
                  )}
                </div>
              ))
            ) : (
              <div className="text-center text-gray-500 py-4">
                <p className="text-sm">No git tokens configured</p>
              </div>
            )}
            <div className="border-t border-[#30363d]"></div>
            <div className="flex justify-center">
              <Button
                onClick={handleAdd}
                type="primary"
                size="small"
                icon={<PlusIcon className="w-3 h-3" />}
                style={{ margin: '8px 0' }}
              >
                New Token
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