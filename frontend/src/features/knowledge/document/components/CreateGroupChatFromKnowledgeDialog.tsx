// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useMemo, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/hooks/useTranslation'
import { useToast } from '@/hooks/use-toast'
import { teamService } from '@/features/tasks/service/teamService'
import { useChatStreamContext } from '@/features/tasks/contexts/chatStreamContext'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { ModelSelector, type Model } from '@/features/tasks/components/selector'
import { useUser } from '@/features/common/UserContext'
import { listGroupMembers } from '@/apis/groups'
import { taskMemberApi } from '@/apis/task-member'
import { taskKnowledgeBaseApi } from '@/apis/task-knowledge-base'
import { listKnowledgeBases } from '@/apis/knowledge'
import type { Group } from '@/types/group'
import type { KnowledgeBase } from '@/types/knowledge'
import type { Team, Task } from '@/types/api'

interface CreateGroupChatFromKnowledgeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  group: Group
  knowledgeBaseName?: string
  knowledgeBaseNamespace?: string
  /** All knowledge bases in the group (used for group-level creation to bind all KBs) */
  knowledgeBases?: KnowledgeBase[]
}

export function CreateGroupChatFromKnowledgeDialog({
  open,
  onOpenChange,
  group,
  knowledgeBaseName,
  knowledgeBaseNamespace,
  knowledgeBases,
}: CreateGroupChatFromKnowledgeDialogProps) {
  const { t } = useTranslation('knowledge')
  const { toast } = useToast()
  const router = useRouter()
  const { user } = useUser()

  const groupDisplayName = group.display_name || group.name

  // Build default title based on whether it's group-level or KB-level
  const defaultTitle = knowledgeBaseName
    ? t('document.groupChat.defaultTitleWithKb', {
        groupName: groupDisplayName,
        kbName: knowledgeBaseName,
      })
    : t('document.groupChat.defaultTitle', { groupName: groupDisplayName })

  const [title, setTitle] = useState(defaultTitle)
  const [selectedTeamId, setSelectedTeamId] = useState<string>('')
  const [selectedModel, setSelectedModel] = useState<Model | null>(null)
  const [forceOverride, setForceOverride] = useState(false)
  const [isCreating, setIsCreating] = useState(false)

  const { teams, isTeamsLoading } = teamService.useTeams()
  const { sendMessage } = useChatStreamContext()
  const { refreshTasks, setSelectedTask } = useTaskContext()

  // Reset title when dialog opens or group/kb changes
  useEffect(() => {
    if (open) {
      setTitle(defaultTitle)
    }
  }, [open, defaultTitle])

  // Filter teams to only show chat-type teams
  const chatTeams = useMemo(() => {
    return teams.filter(team => team.agent_type === 'chat')
  }, [teams])

  // Get selected team object
  const selectedTeam = useMemo(() => {
    if (!selectedTeamId) return null
    return chatTeams.find(t => t.id === parseInt(selectedTeamId)) || null
  }, [selectedTeamId, chatTeams])

  // Check if form is valid
  const isFormValid = useMemo(() => {
    return title.trim().length > 0 && selectedTeamId.length > 0 && selectedModel !== null
  }, [title, selectedTeamId, selectedModel])

  // Add all group members to the newly created group chat
  const addGroupMembersToChat = async (taskId: number) => {
    try {
      const membersResponse = await listGroupMembers(group.name)
      const members = membersResponse.items || []

      // Filter out the current user (already the owner of the group chat)
      const otherMembers = members.filter(member => member.user_id !== user?.id && member.is_active)

      if (otherMembers.length === 0) return

      // Add members concurrently using Promise.allSettled
      const results = await Promise.allSettled(
        otherMembers.map(member => taskMemberApi.addMember(taskId, member.user_id))
      )

      const succeeded = results.filter(r => r.status === 'fulfilled').length
      const failed = results.filter(r => r.status === 'rejected').length

      if (failed === 0) {
        toast({
          title: t('document.groupChat.addMembersSuccess', { count: succeeded }),
        })
      } else if (succeeded > 0) {
        toast({
          title: t('document.groupChat.addMembersPartialFail', {
            failed,
            total: otherMembers.length,
          }),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('document.groupChat.addMembersFailed'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      console.error('[CreateGroupChatFromKnowledge] Failed to add group members:', error)
      toast({
        title: t('document.groupChat.addMembersFailed'),
        variant: 'destructive',
      })
    }
  }

  const resetForm = () => {
    setTitle(defaultTitle)
    setSelectedTeamId('')
    setSelectedModel(null)
    setForceOverride(false)
    setIsCreating(false)
  }

  const handleCreate = async () => {
    if (!title.trim() || !selectedTeamId || !selectedTeam) return

    setIsCreating(true)

    // Capture props in local variables to ensure they're available after async operations
    const kbName = knowledgeBaseName
    const kbNamespace = knowledgeBaseNamespace
    const kbList = knowledgeBases
    const groupName = group.name

    try {
      // Await sendMessage to get the real task ID from the server
      const realTaskId = await sendMessage(
        {
          message: t('common:groupChat.create.initialMessage'),
          team_id: selectedTeam.id,
          task_id: undefined,
          title: title,
          model_id:
            selectedModel?.name === '__default__' ? undefined : selectedModel?.name || undefined,
          force_override_bot_model: forceOverride,
          is_group_chat: true,
        },
        {
          pendingUserMessage: undefined,
          pendingAttachment: null,
          immediateTaskId: -Date.now(),
          currentUserId: user?.id,
          currentUserName: user?.user_name,
          onError: error => {
            toast({
              title: t('common:groupChat.create.failed'),
              description: error.message || t('common:groupChat.create.failedDesc'),
              variant: 'destructive',
            })
            setIsCreating(false)
          },
        }
      )

      if (!realTaskId || realTaskId < 0) {
        console.error('[CreateGroupChatFromKnowledge] Invalid task ID returned:', realTaskId)
        toast({
          title: t('common:groupChat.create.failed'),
          variant: 'destructive',
        })
        setIsCreating(false)
        return
      }

      // Bind knowledge bases using the real task ID
      // Use local variables to avoid stale closure issues
      try {
        if (kbName) {
          // KB-level creation: bind the specific knowledge base
          await taskKnowledgeBaseApi.bindKnowledgeBase(realTaskId, kbName, kbNamespace || 'default')
        } else {
          // Group-level creation: bind all knowledge bases in the group
          let kbsToBind = kbList
          if (!kbsToBind || kbsToBind.length === 0) {
            const response = await listKnowledgeBases('group', groupName)
            kbsToBind = response.items
          }

          if (kbsToBind && kbsToBind.length > 0) {
            const results = await Promise.allSettled(
              kbsToBind.map(kb =>
                taskKnowledgeBaseApi.bindKnowledgeBase(
                  realTaskId,
                  kb.name,
                  kb.namespace || 'default'
                )
              )
            )

            const failed = results.filter(r => r.status === 'rejected').length
            if (failed > 0) {
              console.error(
                `[CreateGroupChatFromKnowledge] Failed to bind ${failed}/${kbsToBind.length} knowledge bases`
              )
              toast({
                title: t('document.groupChat.bindKbPartialFail', {
                  failed,
                  total: kbsToBind.length,
                }),
                variant: 'destructive',
              })
            }
          }
        }
      } catch (bindError) {
        console.error('[CreateGroupChatFromKnowledge] Failed to bind knowledge bases:', bindError)
        toast({
          title: t('document.groupChat.bindKbFailed'),
          variant: 'destructive',
        })
      }

      // Close dialog and reset form
      onOpenChange(false)
      resetForm()

      // Refresh task list
      refreshTasks()

      // Set selected task before navigation
      setSelectedTask({
        id: realTaskId,
        title: title,
        team_id: selectedTeam?.id || 0,
        is_group_chat: true,
      } as Task)

      // Navigate to the new group chat
      router.push(`/chat?taskId=${realTaskId}`)

      // Show success toast
      toast({
        title: t('common:groupChat.create.success'),
        description: t('common:groupChat.create.successDesc'),
      })

      // Add group members in the background after navigation
      void addGroupMembersToChat(realTaskId)
    } catch (error) {
      console.error('[CreateGroupChatFromKnowledge] Failed to create group chat:', error)
      toast({
        title: t('common:groupChat.create.failed'),
        description:
          error instanceof Error ? error.message : t('common:groupChat.create.failedDesc'),
        variant: 'destructive',
      })
      setIsCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('document.groupChat.create')}</DialogTitle>
          <DialogDescription>
            {knowledgeBaseName
              ? t('document.groupChat.createForKb')
              : t('document.groupChat.createForGroup')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="group-chat-title">{t('common:groupChat.create.titleLabel')}</Label>
            <Input
              id="group-chat-title"
              placeholder={t('common:groupChat.create.titlePlaceholder')}
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={100}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="group-chat-team">{t('common:groupChat.create.teamLabel')}</Label>
            <Select value={selectedTeamId} onValueChange={setSelectedTeamId}>
              <SelectTrigger>
                <SelectValue placeholder={t('common:groupChat.create.teamPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {isTeamsLoading ? (
                  <SelectItem value="loading" disabled>
                    {t('common:actions.loading')}
                  </SelectItem>
                ) : chatTeams.length === 0 ? (
                  <SelectItem value="no-teams" disabled>
                    {t('common:groupChat.create.noChatTeams')}
                  </SelectItem>
                ) : (
                  chatTeams.map((team: Team) => (
                    <SelectItem key={team.id} value={String(team.id)}>
                      {team.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Model Selector - only show when a team is selected */}
          {selectedTeam && (
            <div className="space-y-2">
              <Label>{t('common:models.label')}</Label>
              <ModelSelector
                selectedModel={selectedModel}
                setSelectedModel={setSelectedModel}
                forceOverride={forceOverride}
                setForceOverride={setForceOverride}
                selectedTeam={selectedTeam}
                disabled={isCreating}
                isLoading={false}
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isCreating}>
            {t('common:actions.cancel')}
          </Button>
          <Button variant="primary" onClick={handleCreate} disabled={isCreating || !isFormValid}>
            {isCreating ? t('common:actions.creating') : t('common:actions.create')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
