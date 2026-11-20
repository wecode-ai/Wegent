// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useId, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react'
import type {
  CollaborationGroupMember,
  CollaborationOwnedAgent,
  CollaborationWorkspaceMember,
} from '../types'
import type {
  ProjectCreateCollaborationGroupDraft,
  ProjectCreateDialogProps,
  ProjectCreateLabels,
  ProjectCreateProvider,
  ProjectCreateResourceSetup,
  ProjectCreateTarget,
} from './types'
import type { useProjectCreateController } from './useProjectCreateController'
import {
  Bot,
  ChevronDown,
  Cloud,
  HardDrive,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Sparkles,
  UserRound,
  UsersRound,
} from 'lucide-react'
import { DialogForm } from '../controls/DialogForm'
import { TemplateCreateSection } from '../templates/TemplateCreateSection'
import type { TemplatePageNavigation } from '../templates/templatePageNavigation'
import { TemplateEnvironmentSelection } from '../templates/TemplateEnvironmentSelection'
import { ProjectCollaboratorPicker } from './ProjectCollaboratorPicker'
import { ChoiceButton, CollaboratorToken } from './ProjectCreatePrimitives'

type Controller = ReturnType<typeof useProjectCreateController>

interface ProjectCreateFormViewProps {
  groupModelPickerOpen: boolean
  templateConfiguration: { title: string; onBack: () => void } | null
  discardTarget: 'project' | 'group' | null
  commands: Controller['commands']
  nameLabelId: string
  labels: ProjectCreateLabels
  nameInput: RefObject<HTMLInputElement | null>
  repositoryInput: RefObject<HTMLInputElement | null>
  state: Controller['state']
  nameErrorId: string
  testIds: { name?: string; description?: string; confirm?: string } | undefined
  props: ProjectCreateDialogProps
  groupGenerating: boolean
  setAddedPeople: Dispatch<SetStateAction<CollaborationWorkspaceMember[]>>
  setCollaboratorPickerOpen: Dispatch<SetStateAction<boolean>>
  setGroupEditorDraft: Dispatch<SetStateAction<ProjectCreateCollaborationGroupDraft | null>>
  targets: ProjectCreateTarget[]
  cloudLocationDescription: string
  resourceSetup: ProjectCreateResourceSetup | undefined
  people: CollaborationWorkspaceMember[]
  configurationTarget: HTMLElement | null
  templateNavigation: TemplatePageNavigation
  collaboratorsLocked: boolean
  selectedAgents: CollaborationOwnedAgent[]
  revealGenerationAgents(ids: string[]): void
  setGroupGenerationError: Dispatch<SetStateAction<string | null>>
  setGroupModelPickerOpen: Dispatch<SetStateAction<boolean>>
  groupedParticipants: CollaborationGroupMember[]
  participantName: (kind: 'human' | 'agent', id: string) => string
  inGroup: (kind: 'human' | 'agent', id: string) => boolean
  directMembers: CollaborationWorkspaceMember[]
  removeMember: (userId: number) => void
  directAgents: CollaborationOwnedAgent[]
  removeAgent: (resourceId: string) => void
  collaboratorPickerOpen: boolean
  availableAgents: CollaborationOwnedAgent[]
  addAgent: (resourceId: string) => void
  importGroup: (groupId: string) => void
  generationModelsLoading: boolean
  openGroupModelPicker: () => void
  groupRecommendationDismissed: boolean
  setGroupRecommendationDismissed: Dispatch<SetStateAction<boolean>>
  groupGenerationError: string | null
  advancedSettingsOpen: boolean
  setAdvancedSettingsOpen: Dispatch<SetStateAction<boolean>>
  providerSummary: string
  providers: Array<{
    id: ProjectCreateProvider
    icon: ReactNode
    label: string
    description: string
  }>
  groupEditorDraft: ProjectCreateCollaborationGroupDraft | null
  requestProjectClose: () => void
}

export function ProjectCreateFormView({
  groupModelPickerOpen,
  templateConfiguration,
  discardTarget,
  commands,
  nameLabelId,
  labels,
  nameInput,
  repositoryInput,
  state,
  nameErrorId,
  testIds,
  props,
  groupGenerating,
  setAddedPeople,
  setCollaboratorPickerOpen,
  setGroupEditorDraft,
  targets,
  cloudLocationDescription,
  resourceSetup,
  people,
  configurationTarget,
  templateNavigation,
  collaboratorsLocked,
  selectedAgents,
  revealGenerationAgents,
  setGroupGenerationError,
  setGroupModelPickerOpen,
  groupedParticipants,
  participantName,
  inGroup,
  directMembers,
  removeMember,
  directAgents,
  removeAgent,
  collaboratorPickerOpen,
  availableAgents,
  addAgent,
  importGroup,
  generationModelsLoading,
  openGroupModelPicker,
  groupRecommendationDismissed,
  setGroupRecommendationDismissed,
  groupGenerationError,
  advancedSettingsOpen,
  setAdvancedSettingsOpen,
  providerSummary,
  providers,
  groupEditorDraft,
  requestProjectClose,
}: ProjectCreateFormViewProps) {
  const repositoryLabelId = useId()
  const repositoryHintId = useId()
  const repositoryErrorId = useId()
  return (
    <DialogForm
      hidden={groupModelPickerOpen || Boolean(templateConfiguration) || Boolean(discardTarget)}
      style={{
        display:
          groupModelPickerOpen || templateConfiguration || discardTarget ? 'none' : 'contents',
      }}
      onSubmit={event => {
        event.preventDefault()
        void commands.submit()
      }}
    >
      <div className="collaboration-project-create-body">
        <label className="collaboration-project-create-field">
          <span id={nameLabelId}>{labels.name}</span>
          <input
            ref={nameInput}
            required
            aria-labelledby={nameLabelId}
            aria-invalid={state.nameError ? true : undefined}
            aria-describedby={state.nameError ? nameErrorId : undefined}
            data-testid={testIds?.name ?? 'cloud-project-name'}
            value={state.name}
            onChange={event => {
              commands.setName(event.target.value)
              commands.clearError()
            }}
            placeholder={labels.namePlaceholder}
          />
          {state.nameError && (
            <p id={nameErrorId} className="collaboration-project-create-error" role="alert">
              {state.nameError}
            </p>
          )}
        </label>

        {props.workspaceSelection && (
          <label className="collaboration-project-create-field">
            <span>{props.workspaceSelection.label}</span>
            <select
              data-testid="collaboration-project-workspace-select"
              value={props.workspaceSelection.value}
              disabled={state.saving || Boolean(state.createdProject) || groupGenerating}
              onChange={event => {
                setAddedPeople([])
                commands.setMemberUserIds([])
                commands.setAgentResourceIds([])
                commands.setExecutionEnvironmentDeviceIds(null)
                commands.setTemplateGroupDrafts([])
                commands.setCollaborationGroupDraft(null)
                commands.setTemplateDocument(null)
                commands.setTemplatePending(false)
                commands.clearError()
                setCollaboratorPickerOpen(false)
                setGroupEditorDraft(null)
                props.workspaceSelection?.onChange(event.target.value)
              }}
            >
              {props.workspaceSelection.options.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {targets.length > 1 ? (
          <section>
            <header className="collaboration-project-create-section-header">
              <h3>{labels.location}</h3>
              <small>{labels.locationImmutable}</small>
            </header>
            <div
              className={`collaboration-project-create-grid collaboration-project-create-locations columns-${targets.length}`}
            >
              {targets.map(target => {
                const isLocal = target.location === 'local'
                return (
                  <ChoiceButton
                    key={target.location}
                    testId={`cloud-project-location-${target.location}`}
                    selected={state.location === target.location}
                    icon={isLocal ? <HardDrive aria-hidden="true" /> : <Cloud aria-hidden="true" />}
                    label={isLocal ? labels.localLocation : labels.cloudLocation}
                    description={
                      isLocal ? labels.localLocationDescription : cloudLocationDescription
                    }
                    onClick={() => {
                      commands.setLocation(target.location)
                      commands.clearError()
                    }}
                  />
                )
              })}
            </div>
          </section>
        ) : null}

        {state.location === 'cloud' && (
          <section>
            <h3>{labels.visibility}</h3>
            <div className="collaboration-project-create-grid columns-2">
              <ChoiceButton
                testId="cloud-project-visibility-private"
                compact
                selected={state.visibility === 'private'}
                icon={<LockKeyhole aria-hidden="true" />}
                label={labels.privateVisibility}
                description={labels.privateVisibilityDescription}
                onClick={() => commands.setVisibility('private')}
              />
              <ChoiceButton
                testId="cloud-project-visibility-public"
                compact
                selected={state.visibility === 'public'}
                icon={<Cloud aria-hidden="true" />}
                label={labels.publicVisibility}
                description={labels.publicVisibilityDescription}
                onClick={() => commands.setVisibility('public')}
              />
            </div>
            {state.visibility === 'public' && (
              <p className="collaboration-project-create-hint">{labels.publicVisibilityNotice}</p>
            )}
            {state.visibility === 'public' && (
              <p
                className="collaboration-project-create-hint"
                data-testid="cloud-project-public-access-viewer"
              >
                {labels.publicReadOnlyDescription}
              </p>
            )}
            {!state.isAITableProvider && (
              <div>
                <h3>{labels.defaultIssueSecurity}</h3>
                <div className="collaboration-project-create-grid columns-2">
                  <ChoiceButton
                    testId="cloud-project-default-issue-security-open"
                    compact
                    selected={state.defaultIssueSecurity === 'open'}
                    icon={<Cloud aria-hidden="true" />}
                    label={labels.openIssueSecurity}
                    description={labels.openIssueSecurityDescription}
                    onClick={() => commands.setDefaultIssueSecurity('open')}
                  />
                  <ChoiceButton
                    testId="cloud-project-default-issue-security-related"
                    compact
                    selected={state.defaultIssueSecurity === 'related'}
                    icon={<LockKeyhole aria-hidden="true" />}
                    label={labels.relatedIssueSecurity}
                    description={labels.relatedIssueSecurityDescription}
                    onClick={() => commands.setDefaultIssueSecurity('related')}
                  />
                </div>
              </div>
            )}
          </section>
        )}

        {resourceSetup && (
          <TemplateCreateSection
            key={props.workspaceSelection?.value}
            setup={{ ...resourceSetup, members: people }}
            locale={labels.locale}
            initialTemplate={props.initialTemplate}
            configurationHost={{
              target: configurationTarget,
              navigation: templateNavigation,
            }}
            disabled={state.saving || Boolean(state.createdProject)}
            onSelect={document => {
              commands.clearError()
              commands.setTemplateDocument(document)
              if (document) {
                if (!state.name.trim())
                  commands.setName(document.spec.resources.collaboration.project.name)
                if (!state.description.trim())
                  commands.setDescription(document.spec.resources.collaboration.project.description)
              }
            }}
            onChange={(drafts, selected, document) => {
              if (document) commands.setTemplateDocument(document)
              commands.setTemplatePending(selected && drafts === null)
              commands.setTemplateGroupDrafts(drafts ?? [])
            }}
          />
        )}

        {resourceSetup ? (
          <fieldset
            className="collaboration-project-create-collaborators min-w-0 border-0 p-0"
            aria-label={labels.collaborators}
            disabled={collaboratorsLocked}
          >
            <h3>{labels.collaborators}</h3>
            {state.collaborationGroupDraft ? (
              <div
                className="collaboration-project-create-group-summary"
                data-testid="collaboration-project-create-group-summary"
              >
                <div className="collaboration-project-create-group-summary-header">
                  <span>
                    <UsersRound aria-hidden="true" />
                    <strong>{state.collaborationGroupDraft.name}</strong>
                  </span>
                  <button
                    type="button"
                    data-testid="collaboration-project-create-edit-group"
                    onClick={() => {
                      const agentIds = selectedAgents.map(agent => agent.id)
                      revealGenerationAgents(agentIds)
                      setGroupGenerationError(null)
                      setGroupEditorDraft(state.collaborationGroupDraft)
                      setGroupModelPickerOpen(true)
                    }}
                  >
                    <Pencil aria-hidden="true" />
                    {labels.editResponsibilities}
                  </button>
                </div>
                <div className="collaboration-project-create-group-members">
                  {groupedParticipants.map(participant => {
                    const isLeader =
                      participant.kind === state.collaborationGroupDraft?.leader.kind &&
                      participant.id === state.collaborationGroupDraft?.leader.id
                    return (
                      <span
                        key={`${participant.kind}:${participant.id}`}
                        className={isLeader ? 'is-leader' : undefined}
                      >
                        {participant.kind === 'agent' ? (
                          <Bot aria-hidden="true" />
                        ) : (
                          <UserRound aria-hidden="true" />
                        )}
                        <span>
                          <strong>{participantName(participant.kind, participant.id)}</strong>
                          <small>
                            {isLeader
                              ? labels.leaderWorks
                              : participant.responsibility || labels.specialistWorks}
                          </small>
                        </span>
                      </span>
                    )
                  })}
                </div>
                {state.collaborationGroupDraft.instructions ? (
                  <div className="collaboration-project-create-group-principles">
                    <small>{labels.allocationPrinciples}</small>
                    <p>{state.collaborationGroupDraft.instructions}</p>
                  </div>
                ) : null}
                <button
                  type="button"
                  className="collaboration-project-create-group-remove"
                  onClick={() => commands.setCollaborationGroupDraft(null)}
                >
                  {labels.removeGroup}
                </button>
              </div>
            ) : null}
            <div className="collaboration-project-create-collaborator-tokens">
              {!inGroup('human', String(resourceSetup.currentUser.id)) && (
                <CollaboratorToken
                  icon={<UserRound aria-hidden="true" />}
                  label={labels.currentUser}
                />
              )}
              {directMembers.map(member => (
                <CollaboratorToken
                  key={`member:${member.user_id}`}
                  icon={<UserRound aria-hidden="true" />}
                  label={member.user_name}
                  removeLabel={`${labels.cancel} ${member.user_name}`}
                  onRemove={() => removeMember(member.user_id)}
                />
              ))}
              {directAgents.map(agent => (
                <CollaboratorToken
                  key={`agent:${agent.id}`}
                  icon={<Bot aria-hidden="true" />}
                  label={agent.name}
                  removeLabel={`${labels.cancel} ${agent.name}`}
                  onRemove={() => removeAgent(agent.id)}
                />
              ))}
            </div>
            <ProjectCollaboratorPicker
              labels={labels}
              open={collaboratorPickerOpen && !collaboratorsLocked}
              onOpenChange={setCollaboratorPickerOpen}
              people={people.map(member => ({
                id: member.user_id,
                user_name: member.user_name,
                email: member.email,
              }))}
              excludedIds={[resourceSetup.currentUser.id, ...state.memberUserIds]}
              searchUsers={resourceSetup.searchUsers}
              agents={availableAgents}
              groups={resourceSetup.groups}
              onSelectPerson={user => {
                if (collaboratorsLocked) return
                setAddedPeople(current => [
                  ...current.filter(member => member.user_id !== user.id),
                  {
                    id: user.id,
                    user_id: user.id,
                    user_name: user.user_name,
                    email: user.email,
                    role: 'Developer',
                  },
                ])
                commands.setMemberUserIds([...state.memberUserIds, user.id])
                setCollaboratorPickerOpen(false)
              }}
              onSelectAgent={addAgent}
              onSelectGroup={importGroup}
              groupAction={
                selectedAgents.length > 0 && resourceSetup.generateCollaborationGroupDraft ? (
                  <button
                    type="button"
                    data-testid="collaboration-project-create-new-group"
                    disabled={groupGenerating || generationModelsLoading}
                    onClick={openGroupModelPicker}
                  >
                    {groupGenerating ? (
                      <LoaderCircle aria-hidden="true" className="collaboration-spin" />
                    ) : (
                      <Sparkles aria-hidden="true" />
                    )}
                    <span>
                      <strong>{labels.createCollaborationGroup}</strong>
                      <small>
                        {groupGenerating
                          ? labels.generatingGroup
                          : labels.groupRecommendationDescription}
                      </small>
                    </span>
                  </button>
                ) : null
              }
            />
            {!state.collaborationGroupDraft &&
            selectedAgents.length >= 2 &&
            resourceSetup.generateCollaborationGroupDraft &&
            !groupRecommendationDismissed ? (
              <div
                className="collaboration-project-create-group-recommendation"
                data-testid="collaboration-project-create-group-recommendation"
              >
                <Sparkles aria-hidden="true" />
                <div>
                  <strong>{labels.groupRecommendationTitle}</strong>
                  <p>{labels.groupRecommendationDescription}</p>
                  <span>
                    <button type="button" onClick={() => setGroupRecommendationDismissed(true)}>
                      {labels.keepDirectCollaboration}
                    </button>
                    <button
                      type="button"
                      className="collaboration-primary-button"
                      data-testid="collaboration-project-create-organize-group"
                      disabled={groupGenerating}
                      onClick={openGroupModelPicker}
                    >
                      {groupGenerating ? labels.generatingGroup : labels.organizeAsGroup}
                    </button>
                  </span>
                </div>
              </div>
            ) : null}
            {groupGenerationError ? (
              <p className="collaboration-project-create-inline-error" role="alert">
                {groupGenerationError}
              </p>
            ) : null}
          </fieldset>
        ) : null}

        {resourceSetup && (
          <TemplateEnvironmentSelection
            environments={resourceSetup.executionEnvironments ?? []}
            selected={state.executionEnvironmentDeviceIds}
            locale={labels.locale}
            disabled={state.saving || Boolean(state.createdProject)}
            onChange={commands.setExecutionEnvironmentDeviceIds}
            loading={resourceSetup.executionEnvironmentLoading}
            error={resourceSetup.executionEnvironmentError}
            onRetry={resourceSetup.retryExecutionEnvironments}
          />
        )}

        <section className="collaboration-project-create-advanced">
          <button
            type="button"
            className="collaboration-project-create-advanced-trigger"
            aria-expanded={advancedSettingsOpen}
            data-testid="collaboration-project-create-advanced"
            onClick={() => setAdvancedSettingsOpen(current => !current)}
          >
            <span>{labels.advancedSettings}</span>
            {!advancedSettingsOpen && (
              <small className="collaboration-project-create-advanced-summary">
                {providerSummary}
              </small>
            )}
            <ChevronDown aria-hidden="true" />
          </button>
          {advancedSettingsOpen ? (
            <div className="collaboration-project-create-advanced-content">
              <label className="collaboration-project-create-field">
                <span>
                  {labels.description} <small>{labels.optional}</small>
                </span>
                <textarea
                  data-testid={testIds?.description ?? 'cloud-project-description'}
                  value={state.description}
                  onChange={event => commands.setDescription(event.target.value)}
                  placeholder={labels.descriptionPlaceholder}
                />
              </label>
              <section>
                <h3>{labels.taskProvider}</h3>
                <div className="collaboration-project-create-grid collaboration-project-create-providers">
                  {providers.map(provider => (
                    <ChoiceButton
                      key={provider.id}
                      testId={`cloud-project-task-provider-${provider.id}`}
                      selected={state.taskProvider === provider.id}
                      icon={provider.icon}
                      label={provider.label}
                      description={provider.description}
                      onClick={() => {
                        commands.setTaskProvider(provider.id)
                        commands.clearError()
                      }}
                    />
                  ))}
                </div>
              </section>

              {state.repositoryProvider ? (
                <section className="collaboration-project-create-provider-config">
                  <label className="collaboration-project-create-field">
                    <span id={repositoryLabelId}>{labels.repository}</span>
                    <input
                      ref={repositoryInput}
                      required
                      aria-labelledby={repositoryLabelId}
                      aria-invalid={state.repositoryError ? true : undefined}
                      aria-describedby={
                        state.repositoryError
                          ? `${repositoryHintId} ${repositoryErrorId}`
                          : repositoryHintId
                      }
                      data-testid="cloud-project-provider-repository"
                      value={state.repositoryAddress}
                      onChange={event => {
                        commands.setRepositoryAddress(event.target.value)
                        commands.clearError()
                      }}
                      placeholder={
                        state.taskProvider === 'github'
                          ? 'https://github.com/owner/repository'
                          : 'https://gitlab.com/group/project'
                      }
                    />
                    <small id={repositoryHintId}>{labels.repositoryHint}</small>
                    {state.repositoryError && (
                      <p
                        id={repositoryErrorId}
                        className="collaboration-project-create-error"
                        role="alert"
                      >
                        {state.repositoryError}
                      </p>
                    )}
                  </label>
                  <label className="collaboration-project-create-field">
                    <span>
                      {labels.token} <small>{labels.optional}</small>
                    </span>
                    <div className="collaboration-project-create-token">
                      <LockKeyhole aria-hidden="true" />
                      <input
                        data-testid="cloud-project-provider-token"
                        type="password"
                        autoComplete="new-password"
                        value={state.token}
                        onChange={event => commands.setToken(event.target.value)}
                        placeholder={labels.privateRepositoryToken}
                      />
                    </div>
                    <small>
                      {state.location === 'cloud' ? labels.cloudTokenHint : labels.localTokenHint}
                    </small>
                  </label>
                </section>
              ) : null}

              {state.isAITableProvider ? (
                <section className="collaboration-project-create-provider-config">
                  <label className="collaboration-project-create-field">
                    <span>{labels.aitableUrl}</span>
                    <input
                      data-testid="cloud-project-aitable-url"
                      value={state.aitableUrl}
                      onChange={event => {
                        commands.setAitableUrl(event.target.value)
                        commands.clearError()
                      }}
                      placeholder={labels.aitablePlaceholder}
                    />
                    <small className={state.aitableUrl && !state.aitableLink ? 'is-error' : ''}>
                      {state.aitableUrl && !state.aitableLink
                        ? labels.aitableInvalid
                        : labels.aitableHint}
                    </small>
                  </label>
                  <p className="collaboration-project-create-hint">{labels.aitableRuntimeHint}</p>
                </section>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
      {!groupEditorDraft && !groupModelPickerOpen ? (
        <footer className="collaboration-project-create-footer">
          {state.error && (
            <p className="collaboration-project-create-error" role="alert">
              {state.error}
            </p>
          )}
          <div className="collaboration-project-create-footer-actions">
            <button
              type="button"
              disabled={state.saving}
              data-testid="collaboration-project-create-cancel"
              onClick={requestProjectClose}
            >
              {labels.cancel}
            </button>
            <button
              type="submit"
              className="collaboration-primary-button"
              data-testid={testIds?.confirm ?? 'cloud-project-create-confirm'}
              disabled={!state.canSubmit}
            >
              {state.saving
                ? labels.creating
                : state.createdProject
                  ? labels.openCreated
                  : labels.create}
            </button>
          </div>
        </footer>
      ) : null}
    </DialogForm>
  )
}
