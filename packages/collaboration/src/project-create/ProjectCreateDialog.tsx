// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ProjectCreateFormView } from './ProjectCreateFormView'
import { ProjectCreateGroupView } from './ProjectCreateGroupView'
import { DefaultModal } from './ProjectCreatePrimitives'

import type { UnifiedModel } from '@wegent/chat-core/models'
import { GitBranch, Grid3X3, ListTodo } from 'lucide-react'
import { useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useFocusRequest } from '../dom-events'
import { useClock } from '../clock'
import { createGroupGenerationSession } from './groupGenerationSession'
import { ProjectCreateDiscardView } from './ProjectCreateDiscardView'

import { type ComposerInputHandle } from '../composer'
import { createCollaborationTranslator } from '../i18n'
import type { CollaborationWorkspaceMember } from '../types'
import {
  changeCollaborationGroupLeader,
  IncompleteCollaborationGroupGenerationError,
} from './collaborationGroupDraft'
import type { ProjectCreateDialogProps } from './types'
import { useProjectCreateController } from './useProjectCreateController'
import { generationModelKey, useProjectGenerationModels } from './useProjectGenerationModels'
import { useCollaborationTemplateStore } from '../templates/context'
import {
  createTemplatePageNavigation,
  templateConfigurationDetail,
} from '../templates/templatePageNavigation'

/** Show template resource loading and recovery alongside the controller's submission boundary. */
export function ProjectCreateDialog(props: ProjectCreateDialogProps) {
  const {
    targets,
    allowDingTalkAITable,
    labels,
    resourceSetup,
    testIds,
    host,
    onClose,
    workspaceContext,
  } = props
  const { state, commands } = useProjectCreateController(props)
  const nameInput = useRef<HTMLInputElement>(null)
  const repositoryInput = useRef<HTMLInputElement>(null)
  const nameLabelId = useId()
  const nameErrorId = useId()
  const [discardTarget, setDiscardTarget] = useState<'project' | 'group' | null>(null)
  useFocusRequest(nameInput, state.submitErrorField ?? undefined, {
    enabled: state.submitErrorField === 'name',
  })
  const translate = createCollaborationTranslator(labels.locale)
  const generationComposerRef = useRef<ComposerInputHandle>(null)
  const [collaboratorPickerOpen, setCollaboratorPickerOpen] = useState(false)
  const [addedPeople, setAddedPeople] = useState<CollaborationWorkspaceMember[]>([])
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false)
  const [observedErrorField, setObservedErrorField] = useState(state.submitErrorField)
  if (observedErrorField !== state.submitErrorField) {
    setObservedErrorField(state.submitErrorField)
    if (state.submitErrorField === 'repository') setAdvancedSettingsOpen(true)
  }
  useFocusRequest(repositoryInput, state.submitErrorField ?? undefined, {
    enabled: state.submitErrorField === 'repository' && advancedSettingsOpen,
  })
  const [groupRecommendationDismissed, setGroupRecommendationDismissed] = useState(false)
  const [groupModelPickerOpen, setGroupModelPickerOpen] = useState(false)
  const [configurationTarget, setConfigurationTarget] = useState<HTMLElement | null>(null)
  const templateStore = useCollaborationTemplateStore()
  const templateNavigation = useMemo(
    () => createTemplatePageNavigation(templateStore, props.workspaceSelection?.value),
    [templateStore, props.workspaceSelection?.value]
  )
  const templateState = useSyncExternalStore(
    templateNavigation.subscribe,
    templateNavigation.getSnapshot,
    templateNavigation.getSnapshot
  )
  const templateConfiguration = templateConfigurationDetail(
    templateNavigation,
    labels.locale,
    templateState
  )
  const [initialGenerationInstructions] = useState(labels.generationRequestDefault)
  const [groupGenerationInstructions, setGroupGenerationInstructions] = useState(
    labels.generationRequestDefault
  )
  const [generationSession] = useState(createGroupGenerationSession)
  const generation = useSyncExternalStore(
    generationSession.subscribe,
    generationSession.getSnapshot,
    generationSession.getServerSnapshot
  )
  const {
    draft: groupEditorDraft,
    generating: groupGenerating,
    phase: groupGenerationPhase,
    principles: groupGenerationPrinciples,
    leader: groupGenerationLeader,
    revealedAgentIds: revealedGenerationAgentIds,
    responsibilities: groupGenerationResponsibilities,
    stages: groupGenerationStages,
    error: groupGenerationError,
  } = generation
  const setGroupEditorDraft = generationSession.setDraft
  const setGroupGenerationError = generationSession.setError
  const generationNow = useClock(groupGenerating)
  const groupGenerationElapsedSeconds = generation.startedAt
    ? Math.max(0, Math.floor((generationNow - generation.startedAt) / 1000))
    : 0
  const {
    models: generationModels,
    key: selectedGenerationModelKey,
    options: selectedGenerationModelOptions,
    loading: generationModelsLoading,
    error: generationModelsError,
    reload: reloadGenerationModels,
    selectModel: selectGenerationModel,
    setOptions: setSelectedGenerationModelOptions,
  } = useProjectGenerationModels(
    groupModelPickerOpen,
    resourceSetup?.loadCollaborationGroupGenerationModels,
    host?.formatError,
    labels.createFailed
  )
  const collaboratorsLocked = state.saving || Boolean(state.createdProject)
  const people = [...(resourceSetup?.members ?? []), ...addedPeople].filter(
    (member, index, all) =>
      all.findIndex(candidate => candidate.user_id === member.user_id) === index
  )
  const selectedMembers = people.filter(
    member =>
      member.user_id !== resourceSetup?.currentUser.id &&
      state.memberUserIds.includes(member.user_id)
  )
  const selectedGenerationHumans = resourceSetup
    ? [
        {
          id: String(resourceSetup.currentUser.id),
          name: labels.currentUser,
        },
        ...selectedMembers.map(member => ({
          id: String(member.user_id),
          name: member.user_name,
        })),
      ]
    : []
  const selectedAgents =
    resourceSetup?.agents.filter(agent => state.agentResourceIds.includes(agent.id)) ?? []
  const availableAgents =
    resourceSetup?.agents.filter(agent => !state.agentResourceIds.includes(agent.id)) ?? []
  const participantName = (kind: 'human' | 'agent', id: string) => {
    if (kind === 'human') {
      if (id === String(resourceSetup?.currentUser.id)) {
        return labels.currentUser
      }
      return people.find(member => String(member.user_id) === id)?.user_name ?? id
    }
    return resourceSetup?.agents.find(agent => agent.id === id)?.name ?? id
  }
  const removeMember = (userId: number) => {
    if (collaboratorsLocked) return
    commands.setMemberUserIds(state.memberUserIds.filter(candidate => candidate !== userId))
  }
  const removeAgent = (resourceId: string) => {
    if (collaboratorsLocked) return
    commands.setAgentResourceIds(
      state.agentResourceIds.filter(candidate => candidate !== resourceId)
    )
  }
  const addAgent = (resourceId: string) => {
    if (collaboratorsLocked) return
    commands.setAgentResourceIds([...state.agentResourceIds, resourceId])
    setGroupRecommendationDismissed(false)
    setCollaboratorPickerOpen(false)
  }
  const importGroup = (groupId: string) => {
    if (collaboratorsLocked) return
    const group = resourceSetup?.groups.find(candidate => candidate.id === groupId)
    if (!group || !resourceSetup) return
    const groupParticipants = [group.leader, ...group.members].filter(
      (participant, index, participants) =>
        participants.findIndex(
          candidate => candidate.kind === participant.kind && candidate.id === participant.id
        ) === index
    )
    const humanIds = groupParticipants
      .filter(member => member.kind === 'human')
      .map(member => Number(member.id))
      .filter(userId => Number.isFinite(userId) && userId !== resourceSetup.currentUser.id)
    const agentIds = groupParticipants
      .filter(member => member.kind === 'agent')
      .map(member => member.id)
      .filter(id => resourceSetup.agents.some(agent => agent.id === id))
    commands.setMemberUserIds([...new Set([...state.memberUserIds, ...humanIds])])
    commands.setAgentResourceIds([...new Set([...state.agentResourceIds, ...agentIds])])
    commands.setCollaborationGroupDraft({
      name: group.name,
      description: group.description,
      instructions: group.instructions ?? '',
      leader: group.leader,
      members: group.members,
      stages: group.stages,
      executionRequirements: {
        requiredTags: group.execution_requirements?.required_tags ?? [],
      },
    })
    setCollaboratorPickerOpen(false)
  }
  const selectedGenerationModel =
    generationModels.find(model => generationModelKey(model) === selectedGenerationModelKey) ?? null
  const unifiedGenerationModels: UnifiedModel[] = generationModels.map(model => ({
    name: model.modelName,
    type: model.modelType ?? 'runtime',
    displayName: model.displayName,
  }))
  const selectedUnifiedGenerationModel =
    unifiedGenerationModels.find(
      model =>
        generationModelKey({
          modelName: model.name,
          modelType: model.type,
        }) === selectedGenerationModelKey
    ) ?? null
  const openGeneratedGroupDraft = async (instructions = groupGenerationInstructions) => {
    if (!resourceSetup) return
    if (!resourceSetup.generateCollaborationGroupDraft) {
      setGroupGenerationError(labels.groupGenerationUnavailable)
      return
    }
    if (!selectedGenerationModel) {
      setGroupGenerationError(labels.generationModelRequired)
      return
    }
    setCollaboratorPickerOpen(false)
    await generationSession.generate(
      (input, onProgress, onEvent) =>
        resourceSetup.generateCollaborationGroupDraft!(input, onProgress, onEvent),
      {
        projectName: state.name.trim(),
        projectDescription: state.description.trim(),
        generationInstructions: instructions.trim(),
        currentUser: resourceSetup.currentUser,
        members: selectedMembers,
        agents: selectedAgents,
        modelSelection: {
          modelName: selectedGenerationModel.modelName,
          modelType: selectedGenerationModel.modelType,
          options: selectedGenerationModelOptions,
        },
      },
      cause =>
        cause instanceof IncompleteCollaborationGroupGenerationError
          ? labels.generationIncomplete.replace(
              '{sections}',
              cause.missingSections
                .map(section =>
                  section === 'principles' ? labels.allocationPrinciples : labels.generatedWorkflow
                )
                .join(labels.locale === 'zh-CN' ? '、' : ', ')
            )
          : (host?.formatError?.(cause) ??
            (cause instanceof Error && cause.message ? cause.message : labels.createFailed))
    )
  }
  const openGroupModelPicker = () => {
    setCollaboratorPickerOpen(false)
    setGroupGenerationError(null)
    setGroupModelPickerOpen(true)
  }
  const updateGroupParticipant = (
    participant: { kind: 'human' | 'agent'; id: string },
    responsibility: string
  ) => {
    setGroupEditorDraft(current => {
      if (!current) return current
      const update = (candidate: {
        kind: 'human' | 'agent'
        id: string
        responsibility: string
      }) =>
        candidate.kind === participant.kind && candidate.id === participant.id
          ? { ...candidate, responsibility }
          : candidate
      return {
        ...current,
        leader: update(current.leader),
        members: current.members.map(update),
      }
    })
  }
  const setGroupLeader = (participant: { kind: 'human' | 'agent'; id: string }) => {
    setGroupEditorDraft(current => {
      if (!current) return current
      return changeCollaborationGroupLeader(current, participant)
    })
  }
  const groupedParticipants = state.collaborationGroupDraft
    ? [state.collaborationGroupDraft.leader, ...state.collaborationGroupDraft.members].filter(
        (participant, index, participants) =>
          participants.findIndex(
            candidate => candidate.kind === participant.kind && candidate.id === participant.id
          ) === index
      )
    : []
  const inGroup = (kind: 'human' | 'agent', id: string) =>
    groupedParticipants.some(participant => participant.kind === kind && participant.id === id)
  const directMembers = selectedMembers.filter(member => !inGroup('human', String(member.user_id)))
  const directAgents = selectedAgents.filter(agent => !inGroup('agent', agent.id))
  const assignedAgentIds = new Set(revealedGenerationAgentIds)
  const draftParticipants = groupEditorDraft
    ? [groupEditorDraft.leader, ...groupEditorDraft.members]
    : []
  const visibleGroupParticipants = [
    ...selectedGenerationHumans.map(member => {
      const draftParticipant = draftParticipants.find(
        candidate => candidate.kind === 'human' && candidate.id === member.id
      )
      return {
        kind: 'human' as const,
        id: member.id,
        name: member.name,
        responsibility:
          draftParticipant?.responsibility ?? groupGenerationResponsibilities[`human:${member.id}`],
        leader: groupEditorDraft
          ? draftParticipant?.kind === groupEditorDraft.leader.kind &&
            draftParticipant?.id === groupEditorDraft.leader.id
          : groupGenerationLeader?.kind === 'human' && groupGenerationLeader.id === member.id,
        className: 'is-human-standing',
        draftParticipant,
      }
    }),
    ...selectedAgents
      .filter(agent => assignedAgentIds.has(agent.id))
      .map(agent => {
        const draftParticipant = draftParticipants.find(
          candidate => candidate.kind === 'agent' && candidate.id === agent.id
        )
        return {
          kind: 'agent' as const,
          id: agent.id,
          name: agent.name,
          responsibility:
            draftParticipant?.responsibility ?? groupGenerationResponsibilities[agent.id],
          leader: groupEditorDraft
            ? draftParticipant?.kind === groupEditorDraft.leader.kind &&
              draftParticipant?.id === groupEditorDraft.leader.id
            : groupGenerationLeader?.kind === 'agent' && groupGenerationLeader.id === agent.id,
          className: `is-assigned${groupGenerating ? ' is-excited' : ''}`,
          draftParticipant,
        }
      }),
  ]
  const generationPhaseLabel =
    groupGenerationPhase === 'preparing'
      ? labels.preparingGenerationModel
      : labels.generatingResponsibilities
  const renderModal = host?.renderModal ?? (modalProps => <DefaultModal {...modalProps} />)
  const cloudLocationDescription = workspaceContext
    ? `${workspaceContext.name} · ${workspaceContext.owner}`
    : labels.cloudLocationDescription
  const providers = [
    {
      id: 'local' as const,
      icon: <ListTodo aria-hidden="true" />,
      label: labels.builtInProvider,
      description:
        state.location === 'local'
          ? labels.builtInLocalDescription
          : labels.builtInCloudDescription,
    },
    {
      id: 'github' as const,
      icon: <GitBranch aria-hidden="true" />,
      label: 'GitHub',
      description: labels.githubDescription,
    },
    {
      id: 'gitlab' as const,
      icon: <GitBranch aria-hidden="true" />,
      label: 'GitLab',
      description: labels.gitlabDescription,
    },
    ...(allowDingTalkAITable && host?.parseDingTalkAITableLink
      ? [
          {
            id: 'dingtalk_aitable' as const,
            icon: <Grid3X3 aria-hidden="true" />,
            label: labels.aitableProvider,
            description: labels.aitableDescription,
          },
        ]
      : []),
  ]
  const providerSummary =
    state.taskProvider === 'local'
      ? labels.advancedSettingsSummary
      : [
          labels.advancedSettingsSummary,
          providers.find(provider => provider.id === state.taskProvider)?.label,
          state.repositoryError ??
            (state.repositoryProvider && !state.repositoryAddress.trim()
              ? labels.repositoryRequired
              : state.isAITableProvider && !state.aitableLink
                ? labels.aitableInvalid
                : null),
        ]
          .filter(Boolean)
          .join(' · ')

  const closeGroupConfiguration = () => {
    generationSession.cancel()
    setGroupModelPickerOpen(false)
    setGroupEditorDraft(null)
  }
  const requestGroupClose = () => {
    const hasUnsavedGroupDraft =
      groupEditorDraft !== null &&
      JSON.stringify(groupEditorDraft) !== JSON.stringify(state.collaborationGroupDraft)
    if (hasUnsavedGroupDraft || groupGenerating) setDiscardTarget('group')
    else closeGroupConfiguration()
  }
  const requestProjectClose = () => {
    if (state.saving) return
    if (
      state.hasDraft ||
      groupEditorDraft ||
      groupGenerationInstructions !== initialGenerationInstructions
    )
      setDiscardTarget('project')
    else onClose()
  }
  const groupConfiguration = groupModelPickerOpen ? (
    <ProjectCreateGroupView
      requestGroupClose={requestGroupClose}
      discardTarget={discardTarget}
      labels={labels}
      groupEditorDraft={groupEditorDraft}
      commands={commands}
      setGroupEditorDraft={setGroupEditorDraft}
      setGroupModelPickerOpen={setGroupModelPickerOpen}
      setGroupRecommendationDismissed={setGroupRecommendationDismissed}
      generationModelsLoading={generationModelsLoading}
      generationModelsError={generationModelsError}
      reloadGenerationModels={reloadGenerationModels}
      groupGenerationError={groupGenerationError}
      groupGenerating={groupGenerating}
      generationComposerRef={generationComposerRef}
      translate={translate}
      groupGenerationInstructions={groupGenerationInstructions}
      setGroupGenerationInstructions={setGroupGenerationInstructions}
      openGeneratedGroupDraft={openGeneratedGroupDraft}
      generationModels={generationModels}
      selectedAgents={selectedAgents}
      selectedGenerationHumans={selectedGenerationHumans}
      resourceSetup={resourceSetup}
      unifiedGenerationModels={unifiedGenerationModels}
      selectedUnifiedGenerationModel={selectedUnifiedGenerationModel}
      selectedGenerationModelOptions={selectedGenerationModelOptions}
      selectGenerationModel={selectGenerationModel}
      setGroupGenerationError={setGroupGenerationError}
      setSelectedGenerationModelOptions={setSelectedGenerationModelOptions}
      generationPhaseLabel={generationPhaseLabel}
      groupGenerationElapsedSeconds={groupGenerationElapsedSeconds}
      assignedAgentIds={assignedAgentIds}
      visibleGroupParticipants={visibleGroupParticipants}
      setGroupLeader={setGroupLeader}
      updateGroupParticipant={updateGroupParticipant}
      groupGenerationPrinciples={groupGenerationPrinciples}
      groupGenerationStages={groupGenerationStages}
    />
  ) : null

  return renderModal({
    title: discardTarget
      ? discardTarget === 'project'
        ? labels.discardProjectTitle
        : labels.discardGroupTitle
      : groupModelPickerOpen
        ? groupEditorDraft
          ? labels.groupDraftTitle
          : labels.selectGenerationModel
        : (templateConfiguration?.title ?? labels.title),
    closeLabel: labels.close,
    onClose: () => {
      if (discardTarget) setDiscardTarget(null)
      else if (groupModelPickerOpen) requestGroupClose()
      else if (templateConfiguration) templateConfiguration.onBack()
      else requestProjectClose()
    },
    children: (
      <>
        <ProjectCreateFormView
          groupModelPickerOpen={groupModelPickerOpen}
          templateConfiguration={templateConfiguration}
          discardTarget={discardTarget}
          commands={commands}
          nameLabelId={nameLabelId}
          labels={labels}
          nameInput={nameInput}
          repositoryInput={repositoryInput}
          state={state}
          nameErrorId={nameErrorId}
          testIds={testIds}
          props={props}
          groupGenerating={groupGenerating}
          setAddedPeople={setAddedPeople}
          setCollaboratorPickerOpen={setCollaboratorPickerOpen}
          setGroupEditorDraft={setGroupEditorDraft}
          targets={targets}
          cloudLocationDescription={cloudLocationDescription}
          resourceSetup={resourceSetup}
          people={people}
          configurationTarget={configurationTarget}
          templateNavigation={templateNavigation}
          collaboratorsLocked={collaboratorsLocked}
          selectedAgents={selectedAgents}
          revealGenerationAgents={generationSession.revealAgents}
          setGroupGenerationError={setGroupGenerationError}
          setGroupModelPickerOpen={setGroupModelPickerOpen}
          groupedParticipants={groupedParticipants}
          participantName={participantName}
          inGroup={inGroup}
          directMembers={directMembers}
          removeMember={removeMember}
          directAgents={directAgents}
          removeAgent={removeAgent}
          collaboratorPickerOpen={collaboratorPickerOpen}
          availableAgents={availableAgents}
          addAgent={addAgent}
          importGroup={importGroup}
          generationModelsLoading={generationModelsLoading}
          openGroupModelPicker={openGroupModelPicker}
          groupRecommendationDismissed={groupRecommendationDismissed}
          setGroupRecommendationDismissed={setGroupRecommendationDismissed}
          groupGenerationError={groupGenerationError}
          advancedSettingsOpen={advancedSettingsOpen}
          setAdvancedSettingsOpen={setAdvancedSettingsOpen}
          providerSummary={providerSummary}
          providers={providers}
          groupEditorDraft={groupEditorDraft}
          requestProjectClose={requestProjectClose}
        />
        <div ref={setConfigurationTarget} style={{ display: 'contents' }} />
        {groupConfiguration}
        {discardTarget && (
          <ProjectCreateDiscardView
            target={discardTarget}
            labels={labels}
            onKeepEditing={() => setDiscardTarget(null)}
            onDiscard={() => {
              setDiscardTarget(null)
              if (discardTarget === 'group') closeGroupConfiguration()
              else onClose()
            }}
          />
        )}
      </>
    ),
  })
}
