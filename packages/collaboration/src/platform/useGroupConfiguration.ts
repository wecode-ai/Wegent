// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'

import { createCollaborationTranslator } from '../i18n'

import { useCollaborationTemplateStore } from '../templates/context'

import { usePanelData } from './usePanelData'
import { type GroupAgentAction, type GroupCandidate } from './GroupParticipantsEditor'

import type {
  CollaborationAgent,
  CollaborationGroup,
  CollaborationMember,
  CollaborationWorkspaceMember,
  CollaborationWorkspaceRole,
  CollaborationUser,
  CollaborationWorkspace,
} from '../types'

type MemberRole = Exclude<CollaborationWorkspaceRole, 'Owner'>

export function isCurrentDeviceCollaborationAgent(agent: CollaborationAgent): boolean {
  return [
    'current-device-agent',
    'current-device-assistant',
    '当前设备智能体',
    '当前设备助手',
    'Current device Agent',
    'Current device assistant',
  ].includes(agent.agent_id ?? agent.name)
}

export interface WorkspaceResourceCommands {
  loadTemplateAgents?(
    group: CollaborationGroup
  ): Promise<import('../ports/SharedWorkspaceApi').WorkspaceProjectAgent[]>

  createTemplateGroups?(
    document: import('../templates/types').CollaborationTemplate,
    drafts: import('../project-create/types').ProjectCreateCollaborationGroupDraft[],
    resolveRouting?: import('../templates/types').TemplateRoutingResolver
  ): Promise<CollaborationGroup[]>
  searchUsers(query: string): Promise<CollaborationUser[]>
  addMember(userId: number, role: MemberRole): Promise<CollaborationWorkspaceMember>
  updateMember(userId: number, role: MemberRole): Promise<CollaborationWorkspaceMember>
  removeMember(userId: number): Promise<void>
  transferOwnership?(userId: number, version: number): Promise<void>
  createCollaborationGroup(input: {
    name: string
    description?: string
    instructions?: string
    leader: {
      kind: 'human' | 'agent'
      id: string
      name?: string
      responsibility?: string
    }
    members: Array<{
      kind: 'human' | 'agent'
      id: string
      name?: string
      responsibility?: string
    }>
    coordinationMode: 'manager'
    stages?: Array<{
      id: string
      name: string
      description?: string
      assignee?: {
        kind: 'human' | 'agent'
        id: string
        name?: string
        responsibility?: string
      } | null
    }>
    executionRequirements?: {
      requiredTags: string[]
    }
  }): Promise<CollaborationGroup>
  updateCollaborationGroup?(
    groupId: string,
    input: {
      version: number
      name?: string
      description?: string
      instructions?: string
      leader?: {
        kind: 'human' | 'agent'
        id: string
        name?: string
        responsibility?: string
      }
      members?: Array<{
        kind: 'human' | 'agent'
        id: string
        name?: string
        responsibility?: string
      }>
      coordinationMode?: 'manager'
      stages?: Array<{
        id: string
        name: string
        description?: string
        assignee?: {
          kind: 'human' | 'agent'
          id: string
          responsibility?: string
        } | null
      }>
      executionRequirements?: {
        requiredTags: string[]
      }
    }
  ): Promise<CollaborationGroup>
  removeCollaborationGroup(groupId: string): Promise<void>
  addCollaborationGroup?(groupId: string): Promise<CollaborationGroup>
}

export interface CollaborationGroupAgentActions {
  renderCreator?(props: {
    onClose(): void
    onCreated(agent: CollaborationAgent): Promise<void>
  }): ReactNode
  copy?(agent: CollaborationAgent): Promise<CollaborationAgent>
}

const copy = {
  'zh-CN': {
    remove: '移除',
    cancel: '取消',
    collaborationGroups: '协作小组',
    collaborationGroupHint:
      '把分组中的人与智能体组织成可复用的协作小组。负责人负责分解、委派、收敛和最终汇报。',
    groupName: '协作小组名称',
    groupDescription: '协作目标与边界',
    groupRule: '协作规则',
    leader: '负责人',
    membersLabel: '成员',
    stages: '参考阶段',
    stagesHint: '可选',
    addStage: '添加阶段',
    leaderAssignment: '未指定执行者',
    environmentRequirements: '执行环境要求',
    requiredEnvironmentTags: '环境标签',
    environmentTagPlaceholder: '输入标签后按回车',
    manageGroup: '管理',
    saveGroup: '保存',
    backToGroups: '返回协作小组',
    createGroup: '创建协作小组',
    noGroups: '分组中还没有协作小组',
    noProjectGroups: '当前项目还没有使用协作小组',
    availableWorkspaceGroups: '可从协作分组添加',
    workspaceOwned: '分组资源',
    projectOwned: '项目资源',
    removeFromProject: '移出项目',
    deleteProjectGroup: '删除',
    deleteGroup: '删除协作小组',
    deleteGroupConfirm: '删除后无法恢复。确认删除这个协作小组吗？',
    removeGroupConfirm: '确认移除此协作小组关联吗？小组源资源会保留。',
    deleting: '删除中…',
    operationFailed: '操作失败，请稍后重试',
    createAgent: '新建智能体',
    createAgentHint: '配置一个仅属于当前协作小组的智能体',
    copyAgent: '复制其他小组的智能体',
    copyAgentHint: '复制配置并加入当前协作小组',
    copyAgentTitle: '复制智能体配置',
    noCopyableAgents: '没有可复制的智能体',
  },
  en: {
    remove: 'Remove',
    cancel: 'Cancel',
    collaborationGroups: 'Collaboration groups',
    collaborationGroupHint:
      'Organize people and agents into reusable execution units. The leader plans, delegates, consolidates, and reports.',
    groupName: 'Group name',
    groupDescription: 'Goal and boundaries',
    groupRule: 'Collaboration rules',
    leader: 'Leader',
    membersLabel: 'Members',
    stages: 'Reference stages',
    stagesHint: 'Optional',
    addStage: 'Add stage',
    leaderAssignment: 'No assigned executor',
    environmentRequirements: 'Execution requirements',
    requiredEnvironmentTags: 'Environment tags',
    environmentTagPlaceholder: 'Enter a tag and press Enter',
    manageGroup: 'Manage',
    saveGroup: 'Save',
    backToGroups: 'Back to groups',
    createGroup: 'Create group',
    noGroups: 'No collaboration groups in this workspace',
    noProjectGroups: 'This project is not using a collaboration group',
    availableWorkspaceGroups: 'Available from workspace',
    workspaceOwned: 'Workspace resource',
    projectOwned: 'Project resource',
    removeFromProject: 'Remove from project',
    deleteProjectGroup: 'Delete',
    deleteGroup: 'Delete group',
    removeGroupConfirm: 'Remove this group association? The source group will be retained.',
    deleteGroupConfirm: 'This cannot be undone. Delete this collaboration group?',
    deleting: 'Deleting…',
    operationFailed: 'Operation failed. Please try again.',
    createAgent: 'Create agent',
    createAgentHint: 'Configure an agent owned only by this group',
    copyAgent: 'Copy agent from another group',
    copyAgentHint: 'Copy its configuration into this collaboration group',
    copyAgentTitle: 'Copy agent configuration',
    noCopyableAgents: 'No agents are available to copy',
  },
} as const

export function useGroupConfiguration({
  workspace,
  groups,
  collectionState = 'ready',
  availableGroups = [],
  members: suppliedMembers,
  agents: suppliedAgents,
  loadParticipants,
  locale,
  currentUserId,
  includeCurrentUserByDefault = true,
  commands,
  canManage: canManageOverride,
  initialCreateOpen = false,
  onCreateOpenChange,
  initialSelectedGroupId = null,
  onDetailClose,
  detailPresentation = 'page',
  agentActions,
  showGroupCollection = true,
  agentConfiguration,
}: {
  workspace?: CollaborationWorkspace
  groups: CollaborationGroup[]
  collectionState?: 'loading' | 'ready' | 'error'
  availableGroups?: CollaborationGroup[]
  members: Array<Pick<CollaborationMember, 'user_id' | 'user_name'>>
  agents: CollaborationAgent[]
  loadParticipants?(): Promise<{
    members: CollaborationWorkspaceMember[]
    agents: CollaborationAgent[]
  }>
  locale: 'zh-CN' | 'en'
  currentUserId?: number
  includeCurrentUserByDefault?: boolean
  commands: WorkspaceResourceCommands
  canManage?: boolean
  initialCreateOpen?: boolean
  onCreateOpenChange?(open: boolean): void
  initialSelectedGroupId?: string | null
  onDetailClose?(): void
  detailPresentation?: 'page' | 'dialog'
  agentActions?: CollaborationGroupAgentActions
  showGroupCollection?: boolean
  agentConfiguration?: import('../project-agent-config/types').ProjectAgentConfigurationHost
}) {
  const messages = copy[locale]
  const templateStore = useCollaborationTemplateStore()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [leader, setLeader] = useState('')
  const [createMembers, setCreateMembers] = useState<CollaborationGroup['members']>([])
  const [formOpen, setFormOpenState] = useState(initialCreateOpen)
  const setFormOpen = (open: boolean) => {
    if (open === formOpen) return
    setFormOpenState(open)
    onCreateOpenChange?.(open)
  }
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(initialSelectedGroupId)
  const [pendingRemoval, setPendingRemoval] = useState<{
    group: CollaborationGroup
    prefix: string
  } | null>(null)
  const participants = usePanelData(loadParticipants, Boolean(formOpen || selectedGroupId))
  const members = participants.data?.members ?? suppliedMembers
  const agents = participants.data?.agents ?? suppliedAgents
  const participantsPending = Boolean(
    loadParticipants && (!participants.data || participants.loading)
  )
  const translate = useMemo(() => createCollaborationTranslator(locale), [locale])

  const [mentionOpen, setMentionOpen] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [initializedGroup, setInitializedGroup] = useState<string | null>(null)
  const [savedDraft, setSavedDraft] = useState('')
  const [draftDescription, setDraftDescription] = useState('')
  const [draftInstructions, setDraftInstructions] = useState('')
  const [draftLeader, setDraftLeader] = useState('')
  const [draftMembers, setDraftMembers] = useState<CollaborationGroup['members']>([])
  const [draftStages, setDraftStages] = useState<CollaborationGroup['stages']>([])
  const [draftRequiredEnvironmentTags, setDraftRequiredEnvironmentTags] = useState<string[]>([])
  const [environmentTagInput, setEnvironmentTagInput] = useState('')
  const [createdAgents, setCreatedAgents] = useState<CollaborationAgent[]>([])
  const [agentCreatorOpen, setAgentCreatorOpen] = useState(false)
  const [copyAgentOpen, setCopyAgentOpen] = useState(false)
  const [agentActionBusy, setAgentActionBusy] = useState(false)
  const ruleEditorRef = useRef<HTMLTextAreaElement>(null)
  const canManage =
    canManageOverride ??
    (workspace?.access_role === 'Owner' ||
      workspace?.access_role === 'Maintainer' ||
      workspace?.access_role === 'Developer')
  const collaborationGroupAgentId = (agent: CollaborationAgent) => String(agent.team_id ?? agent.id)
  const allAgents = useMemo(() => {
    const byId = new Map<string, CollaborationAgent>()
    ;[...agents, ...createdAgents].forEach(agent => {
      byId.set(String(agent.team_id ?? agent.id), agent)
    })
    return [...byId.values()]
  }, [agents, createdAgents])
  const candidates = [
    ...allAgents.map(agent => ({
      value: `agent:${collaborationGroupAgentId(agent)}`,
      kind: 'agent' as const,
      id: collaborationGroupAgentId(agent),
      name: agent.name,
    })),
    ...members.map(member => ({
      value: `human:${member.user_id}`,
      kind: 'human' as const,
      id: String(member.user_id),
      name:
        member.user_id === currentUserId ? (locale === 'zh-CN' ? '我' : 'Me') : member.user_name,
    })),
  ]
  // Persist display names with the roster so a manager can resolve "@name"
  // references in the group rules instead of seeing bare member ids. People
  // keep their real user name; the picker label ("我") is presentation only.
  const persistedMemberName = (kind: 'human' | 'agent', id: string, storedName = ''): string => {
    if (kind === 'human') {
      return members.find(member => String(member.user_id) === id)?.user_name || storedName
    }
    const candidate = candidates.find(entry => entry.kind === kind && entry.id === id)
    return candidate?.name || storedName
  }
  const withCandidateName = <T extends { kind: 'human' | 'agent'; id: string; name?: string }>(
    member: T
  ): T & { name: string } => ({
    ...member,
    name: persistedMemberName(member.kind, member.id, member.name),
  })
  const selectedGroup = groups.find(group => group.id === selectedGroupId) ?? null
  const agentIdsOwnedByOtherGroups = new Set(
    groups.flatMap(group => {
      if (group.id === selectedGroupId) return []
      const ids = group.members.filter(member => member.kind === 'agent').map(member => member.id)
      if (group.leader.kind === 'agent') ids.push(group.leader.id)
      return ids
    })
  )
  const copyableAgents = allAgents.filter(agent =>
    agentIdsOwnedByOtherGroups.has(collaborationGroupAgentId(agent))
  )

  const addCreatedAgent = (agent: CollaborationAgent) => {
    const agentId = collaborationGroupAgentId(agent)
    const candidate: GroupCandidate = {
      value: `agent:${agentId}`,
      kind: 'agent',
      id: agentId,
      name: agent.name,
    }
    setCreatedAgents(current => [
      ...current.filter(item => collaborationGroupAgentId(item) !== agentId),
      agent,
    ])
    if (selectedGroup) {
      setDraftMembers(current =>
        current.some(member => member.kind === 'agent' && member.id === agentId)
          ? current
          : [...current, { kind: 'agent', id: agentId, responsibility: '' }]
      )
      if (!draftLeader) setDraftLeader(candidate.value)
      return
    }
    setCreateMembers(current =>
      current.some(member => member.kind === 'agent' && member.id === agentId)
        ? current
        : [...current, { kind: 'agent', id: agentId, responsibility: '' }]
    )
    if (!leader) setLeader(candidate.value)
  }

  const groupAgentActions: GroupAgentAction[] = [
    ...(agentActions?.renderCreator
      ? [
          {
            id: 'create' as const,
            label: messages.createAgent,
            description: messages.createAgentHint,
            onSelect: () => setAgentCreatorOpen(true),
          },
        ]
      : []),
    ...(agentActions?.copy
      ? [
          {
            id: 'copy' as const,
            label: messages.copyAgent,
            description: messages.copyAgentHint,
            onSelect: () => setCopyAgentOpen(true),
          },
        ]
      : []),
  ]

  const [removalSelection, setRemovalSelection] = useState(selectedGroupId)
  if (removalSelection !== selectedGroupId) {
    setRemovalSelection(selectedGroupId)
    setPendingRemoval(null)
  }
  const [initializedCreateUser, setInitializedCreateUser] = useState<number>()
  if (!formOpen && initializedCreateUser !== undefined) setInitializedCreateUser(undefined)
  if (
    formOpen &&
    includeCurrentUserByDefault &&
    currentUserId != null &&
    initializedCreateUser !== currentUserId
  ) {
    const currentMember = members.find(member => member.user_id === currentUserId)
    if (currentMember) {
      setInitializedCreateUser(currentUserId)
      if (
        !createMembers.some(
          member => member.kind === 'human' && member.id === String(currentMember.user_id)
        )
      ) {
        setCreateMembers([
          {
            kind: 'human',
            id: String(currentMember.user_id),
            responsibility: '',
          },
          ...createMembers,
        ])
      }
      if (!leader) setLeader(`human:${currentMember.user_id}`)
    }
  }

  const restoreGroupDraft = useCallback((group: CollaborationGroup) => {
    const leaderIdentity = group.leader.kind + ':' + group.leader.id
    const members = group.members.map(member => ({
      ...member,
      responsibility: member.kind + ':' + member.id === leaderIdentity ? '' : member.responsibility,
    }))
    const stages = group.stages.map(stage => ({
      ...stage,
      assignee:
        stage.assignee && stage.assignee.kind + ':' + stage.assignee.id !== leaderIdentity
          ? { ...stage.assignee }
          : null,
    }))
    const tags = group.execution_requirements?.required_tags ?? []
    setDraftName(group.name)
    setDraftDescription(group.description)
    setDraftInstructions(group.instructions ?? '')
    setDraftLeader(leaderIdentity)
    setDraftMembers(members)
    setDraftStages(stages)
    setDraftRequiredEnvironmentTags(tags)
    setSavedDraft(
      JSON.stringify([
        group.name,
        group.description,
        group.instructions ?? '',
        leaderIdentity,
        members,
        stages,
        tags,
      ])
    )
    setMentionOpen(false)
    setEnvironmentTagInput('')
    setError(null)
  }, [])

  const selectedRevision = selectedGroup ? selectedGroup.id + ':' + selectedGroup.version : null
  if (initializedGroup !== selectedRevision) {
    setInitializedGroup(selectedRevision)
    if (selectedGroup) restoreGroupDraft(selectedGroup)
  }

  const dirty =
    savedDraft !==
    JSON.stringify([
      draftName,
      draftDescription,
      draftInstructions,
      draftLeader,
      draftMembers,
      draftStages,
      draftRequiredEnvironmentTags,
    ])

  const displayName = (kind: 'human' | 'agent', id: string) =>
    candidates.find(candidate => candidate.kind === kind && candidate.id === id)?.name ?? ''
  const executableDraftMembers = draftMembers.filter(
    member =>
      `${member.kind}:${member.id}` !== draftLeader && Boolean(displayName(member.kind, member.id))
  )
  const executableDraftMemberIds = new Set(
    executableDraftMembers.map(member => `${member.kind}:${member.id}`)
  )

  const updateMemberSelection = (candidate: (typeof candidates)[number], selected: boolean) => {
    const identity = `${candidate.kind}:${candidate.id}`
    setDraftMembers(current => {
      if (selected) {
        return current.some(member => member.kind === candidate.kind && member.id === candidate.id)
          ? current
          : [
              ...current,
              {
                kind: candidate.kind,
                id: candidate.id,
                responsibility: '',
              },
            ]
      }
      return current.filter(member => member.kind !== candidate.kind || member.id !== candidate.id)
    })
    if (!selected && draftLeader === identity) {
      const replacement = draftMembers.find(member => `${member.kind}:${member.id}` !== identity)
      setDraftLeader(replacement ? `${replacement.kind}:${replacement.id}` : '')
    }
    if (!selected) {
      setDraftStages(current =>
        current.map(stage =>
          stage.assignee?.kind === candidate.kind && stage.assignee.id === candidate.id
            ? { ...stage, assignee: null }
            : stage
        )
      )
    }
  }

  const updateCreateMemberSelection = (
    candidate: (typeof candidates)[number],
    selected: boolean
  ) => {
    setCreateMembers(current => {
      if (selected) {
        return current.some(member => member.kind === candidate.kind && member.id === candidate.id)
          ? current
          : [
              ...current,
              {
                kind: candidate.kind,
                id: candidate.id,
                responsibility: '',
              },
            ]
      }
      return current.filter(member => member.kind !== candidate.kind || member.id !== candidate.id)
    })
    if (selected && !leader) {
      setLeader(candidate.value)
    }
  }

  const updateCreateMemberResponsibility = (
    candidate: (typeof candidates)[number],
    responsibility: string
  ) => {
    setCreateMembers(current =>
      current.map(member =>
        member.kind === candidate.kind && member.id === candidate.id
          ? { ...member, responsibility }
          : member
      )
    )
  }

  const insertRuleMention = (candidate: (typeof candidates)[number]) => {
    const textarea = ruleEditorRef.current
    const start = textarea?.selectionStart ?? draftInstructions.length
    const end = textarea?.selectionEnd ?? start
    const rawPrefix = draftInstructions.slice(0, start)
    const prefix = rawPrefix.endsWith('@') ? rawPrefix.slice(0, -1) : rawPrefix
    const suffix = draftInstructions.slice(end)
    const leadingSpace = prefix && !/\s$/.test(prefix) ? ' ' : ''
    const trailingSpace = suffix && /^\s/.test(suffix) ? '' : ' '
    const mention = `@${candidate.name}`
    const nextValue = `${prefix}${leadingSpace}${mention}${trailingSpace}${suffix}`
    const nextCaret = prefix.length + leadingSpace.length + mention.length + trailingSpace.length
    setDraftInstructions(nextValue)
    setMentionOpen(false)
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const addRequiredEnvironmentTag = () => {
    const nextTag = environmentTagInput.trim()
    if (!nextTag) return
    setDraftRequiredEnvironmentTags(current =>
      current.includes(nextTag) ? current : [...current, nextTag]
    )
    setEnvironmentTagInput('')
  }
  return {
    addCreatedAgent,
    addRequiredEnvironmentTag,
    agentActionBusy,
    agentActions,
    agentConfiguration,
    agentCreatorOpen,
    availableGroups,
    canManage,
    candidates,
    collaborationGroupAgentId,
    commands,
    copyAgentOpen,
    copyableAgents,
    createMembers,
    currentUserId,
    description,
    detailPresentation,
    dirty,
    displayName,
    draftDescription,
    draftInstructions,
    draftLeader,
    draftMembers,
    draftName,
    draftRequiredEnvironmentTags,
    draftStages,
    environmentTagInput,
    error,
    executableDraftMemberIds,
    executableDraftMembers,
    formOpen,
    groupAgentActions,
    groups,
    collectionState,
    insertRuleMention,
    leader,
    loadParticipants,
    locale,
    mentionOpen,
    messages,
    name,
    onDetailClose,
    participants,
    participantsPending,
    pendingRemoval,
    persistedMemberName,
    restoreGroupDraft,
    ruleEditorRef,
    saving,
    selectedGroup,
    selectedGroupId,
    setAgentActionBusy,
    setAgentCreatorOpen,
    setCopyAgentOpen,
    setCreateMembers,
    setDescription,
    setDraftDescription,
    setDraftInstructions,
    setDraftLeader,
    setDraftMembers,
    setDraftName,
    setDraftRequiredEnvironmentTags,
    setDraftStages,
    setEnvironmentTagInput,
    setError,
    setFormOpen,
    setLeader,
    setMentionOpen,
    setName,
    setPendingRemoval,
    setSaving,
    setSelectedGroupId,
    showGroupCollection,
    templateStore,
    translate,
    updateCreateMemberResponsibility,
    updateCreateMemberSelection,
    updateMemberSelection,
    withCandidateName,
    workspace,
  }
}

export type GroupConfigurationModel = ReturnType<typeof useGroupConfiguration>
