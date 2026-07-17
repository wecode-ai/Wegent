// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import '@/features/common/scrollbar.css'
import { Button } from '@/components/ui/button'
import { Bars3Icon, PencilIcon, TrashIcon } from '@heroicons/react/24/outline'
import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { FiGithub, FiGitlab, FiGitBranch } from 'react-icons/fi'
import { SiGitea } from 'react-icons/si'
import GitHubEdit from './GitHubEdit'
import UnifiedAddButton from '@/components/common/UnifiedAddButton'
import LoadingState from '@/features/common/LoadingState'
import { GitInfo } from '@/types/api'
import { useUser } from '@/features/common/UserContext'
import { fetchGitInfo, deleteGitToken, reorderGitTokens } from '../services/github'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'

interface SortableGitTokenProps {
  info: GitInfo
  index: number
  itemKey: string
  maskedToken: string | null
  onEdit: (info: GitInfo) => void
  onDelete: (info: GitInfo) => void
  t: (key: string) => string
}

function SortableGitToken({
  info,
  index,
  itemKey,
  maskedToken,
  onEdit,
  onDelete,
  t,
}: SortableGitTokenProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: itemKey,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center justify-between rounded-md border border-border/70 bg-surface px-3 py-2.5 ${isDragging ? 'relative z-10 opacity-80 shadow-md' : ''}`}
      data-testid={`git-token-item-${index}`}
    >
      <div className="flex items-center space-x-3 min-w-0 flex-1">
        <button
          type="button"
          className="cursor-grab touch-none rounded p-1 text-text-muted hover:bg-fill-tertiary hover:text-text-primary active:cursor-grabbing"
          title={t('common:integrations.drag_to_reorder')}
          aria-label={t('common:integrations.drag_to_reorder')}
          data-testid={`drag-git-token-${index}`}
          {...attributes}
          {...listeners}
        >
          <Bars3Icon className="h-5 w-5" />
        </button>
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
              <span className="text-xs text-text-muted ml-2 flex-shrink-0">({info.git_login})</span>
            )}
          </div>
          <p className="text-xs text-text-muted break-all font-mono">
            {info.type === 'gerrit' && info.user_name ? `${info.user_name} | ` : ''}
            {maskedToken}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0 ml-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onEdit(info)}
          title={t('common:integrations.edit_token')}
          className="h-8 w-8"
          data-testid={`edit-git-token-${index}`}
        >
          <PencilIcon className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDelete(info)}
          title={t('common:integrations.delete')}
          className="h-8 w-8 hover:text-error"
          data-testid={`delete-git-token-${index}`}
        >
          <TrashIcon className="w-4 h-4" />
        </Button>
      </div>
    </div>
  )
}

export default function GitHubIntegration() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { user, refresh } = useUser()
  const [gitInfo, setGitInfo] = useState<GitInfo[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [modalType, setModalType] = useState<'add' | 'edit'>('add')
  const [currentEditInfo, setCurrentEditInfo] = useState<GitInfo | null>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

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

  const getItemKey = (info: GitInfo) => {
    if (info.id) return info.id
    return `legacy:${user?.git_info.indexOf(info) ?? gitInfo.indexOf(info)}`
  }

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

  const handleDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    const oldIndex = platforms.findIndex(info => getItemKey(info) === active.id)
    const newIndex = platforms.findIndex(info => getItemKey(info) === over.id)
    if (oldIndex < 0 || newIndex < 0) return

    const previous = platforms
    const reordered = arrayMove(platforms, oldIndex, newIndex)
    setGitInfo(reordered)
    try {
      await reorderGitTokens(reordered.map(getItemKey))
      await refresh()
    } catch {
      setGitInfo(previous)
      toast({ variant: 'destructive', title: t('common:integrations.reorder_failed') })
    }
  }

  return (
    <div
      className="space-y-3 rounded-md border border-border bg-base p-4"
      data-testid="git-tokens-section"
    >
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
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={platforms.map(getItemKey)}
                strategy={verticalListSortingStrategy}
              >
                <div
                  className="space-y-2 max-h-[50vh] overflow-y-auto custom-scrollbar"
                  data-testid="git-token-list"
                >
                  {platforms.map((info, index) => (
                    <SortableGitToken
                      key={getItemKey(info)}
                      info={info}
                      index={index}
                      itemKey={getItemKey(info)}
                      maskedToken={getMaskedTokenDisplay(info.git_token)}
                      onEdit={handleEdit}
                      onDelete={handleDelete}
                      t={t}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}

          {platforms.length === 0 && (
            <div
              className="rounded-md border border-border/70 bg-surface px-3 py-4 text-center"
              data-testid="git-token-empty-state"
            >
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
