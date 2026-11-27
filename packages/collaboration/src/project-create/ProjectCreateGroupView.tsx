import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { UnifiedModel } from '@wegent/chat-core/models'
import { Bot, LoaderCircle, Sparkles, UserRound } from 'lucide-react'
import { useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { ComposerInputHandle } from '../composer'
import { ComposerTextInput, ProjectComposerBody } from '../composer'
import { ModelSelector } from '../controls/ModelSelector'
import type { CollaborationTranslate } from '../i18n'
import type { CollaborationGroupRosterParticipant } from '../platform/CollaborationGroupRoster'
import { CollaborationGroupRoster } from '../platform/CollaborationGroupRoster'
import type { CollaborationGroupMember, CollaborationOwnedAgent } from '../types'
import { HoverEditableText } from './HoverEditableText'
import { ProjectCreateConfigurationView } from './ProjectCreateConfigurationView'
import { CollaborationGroupWorkflow } from './ProjectCreatePrimitives'
import type {
  ProjectCreateCollaborationGroupDraft,
  ProjectCreateGenerationModel,
  ProjectCreateGenerationModelSelection,
  ProjectCreateLabels,
  ProjectCreateResourceSetup,
} from './types'
import type { useProjectCreateController } from './useProjectCreateController'

type Controller = ReturnType<typeof useProjectCreateController>

interface ProjectCreateGroupViewProps {
  requestGroupClose: () => void
  discardTarget: 'project' | 'group' | null
  labels: ProjectCreateLabels
  groupEditorDraft: ProjectCreateCollaborationGroupDraft | null
  commands: Controller['commands']
  setGroupEditorDraft: Dispatch<SetStateAction<ProjectCreateCollaborationGroupDraft | null>>
  setGroupModelPickerOpen: Dispatch<SetStateAction<boolean>>
  setGroupRecommendationDismissed: Dispatch<SetStateAction<boolean>>
  generationModelsLoading: boolean
  generationModelsError: string | null
  reloadGenerationModels: () => Promise<void>
  groupGenerationError: string | null
  groupGenerating: boolean
  generationComposerRef: RefObject<ComposerInputHandle | null>
  translate: CollaborationTranslate
  groupGenerationInstructions: string
  setGroupGenerationInstructions: Dispatch<SetStateAction<string>>
  openGeneratedGroupDraft: (instructions?: string) => Promise<void>
  generationModels: ProjectCreateGenerationModel[]
  selectedAgents: CollaborationOwnedAgent[]
  selectedGenerationHumans: { id: string; name: string }[]
  resourceSetup: ProjectCreateResourceSetup | undefined
  unifiedGenerationModels: UnifiedModel[]
  selectedUnifiedGenerationModel: UnifiedModel | null
  selectedGenerationModelOptions: Record<string, string>
  selectGenerationModel: (
    selection: ProjectCreateGenerationModelSelection,
    options?: Record<string, string>
  ) => boolean
  setGroupGenerationError: Dispatch<SetStateAction<string | null>>
  setSelectedGenerationModelOptions: (options: SetStateAction<Record<string, string>>) => void
  generationPhaseLabel: string
  groupGenerationElapsedSeconds: number
  assignedAgentIds: Set<string>
  visibleGroupParticipants: Array<
    CollaborationGroupRosterParticipant & { draftParticipant: CollaborationGroupMember | undefined }
  >
  setGroupLeader: (participant: { kind: 'human' | 'agent'; id: string }) => void
  updateGroupParticipant: (
    participant: { kind: 'human' | 'agent'; id: string },
    responsibility: string
  ) => void
  groupGenerationPrinciples: string[]
  groupGenerationStages: { id: string; name: string }[]
}

export function ProjectCreateGroupView({
  requestGroupClose,
  discardTarget,
  labels,
  groupEditorDraft,
  commands,
  setGroupEditorDraft,
  setGroupModelPickerOpen,
  setGroupRecommendationDismissed,
  generationModelsLoading,
  generationModelsError,
  reloadGenerationModels,
  groupGenerationError,
  groupGenerating,
  generationComposerRef,
  translate,
  groupGenerationInstructions,
  setGroupGenerationInstructions,
  openGeneratedGroupDraft,
  generationModels,
  selectedAgents,
  selectedGenerationHumans,
  resourceSetup,
  unifiedGenerationModels,
  selectedUnifiedGenerationModel,
  selectedGenerationModelOptions,
  selectGenerationModel,
  setGroupGenerationError,
  setSelectedGenerationModelOptions,
  generationPhaseLabel,
  groupGenerationElapsedSeconds,
  assignedAgentIds,
  visibleGroupParticipants,
  setGroupLeader,
  updateGroupParticipant,
  groupGenerationPrinciples,
  groupGenerationStages,
}: ProjectCreateGroupViewProps) {
  const [generationModelMenuOpen, setGenerationModelMenuOpen] = useState(false)
  // The SDK preserves live regions and their ancestors during modal isolation.
  const announceGeneration = !generationModelMenuOpen
  const hasPartialPreview = Boolean(
    groupGenerationError &&
    (visibleGroupParticipants.some(participant => participant.responsibility) ||
      groupGenerationPrinciples.length > 0 ||
      groupGenerationStages.length > 0)
  )
  return (
    <ProjectCreateConfigurationView
      onBack={requestGroupClose}
      active={!discardTarget}
      focusLabel={labels.selectGenerationModel}
      focusTarget={
        groupGenerating
          ? null
          : groupEditorDraft
            ? '[data-testid="collaboration-project-create-group-name"]'
            : '[data-testid="collaboration-project-create-generation-instructions"]'
      }
      backLabel={labels.backToProject}
      testId="collaboration-project-create-model-picker"
      restoreFocus='[data-testid="collaboration-project-create-edit-group"], [data-testid="collaboration-project-create-add-collaborator"]'
      footer={
        groupEditorDraft ? (
          <ControlButton
            variant="unstyled"
            type="button"
            className="collaboration-primary-button"
            data-testid="collaboration-project-create-apply-group"
            disabled={!groupEditorDraft.name.trim()}
            onClick={() => {
              commands.setCollaborationGroupDraft({
                ...groupEditorDraft,
                name: groupEditorDraft.name.trim(),
              })
              setGroupEditorDraft(null)
              setGroupModelPickerOpen(false)
              setGroupRecommendationDismissed(true)
            }}
          >
            {labels.applyGroup}
          </ControlButton>
        ) : undefined
      }
    >
      <div className="collaboration-project-create-group-editor is-generator">
        <p
          className="sr-only"
          role={announceGeneration ? 'status' : undefined}
          aria-live={announceGeneration ? 'polite' : undefined}
          aria-atomic="true"
          data-testid="collaboration-project-create-generation-status"
        >
          {groupGenerating
            ? generationPhaseLabel
            : groupEditorDraft
              ? labels.generationCompleted
              : ''}
        </p>
        {generationModelsLoading ? (
          <p role={announceGeneration ? 'status' : undefined} className="text-sm text-text-secondary">
            {labels.loadingGenerationModels}
          </p>
        ) : null}
        {generationModelsError ? (
          <p
            className="collaboration-project-create-inline-error"
            role={announceGeneration ? 'alert' : undefined}
          >
            {generationModelsError}
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="collaboration-project-create-retry-models"
              className="collaboration-secondary-button min-h-11"
              onClick={() => void reloadGenerationModels()}
              disabled={generationModelsLoading}
            >
              {labels.reloadGenerationModels}
            </ControlButton>
          </p>
        ) : null}
        {groupGenerationError ? (
          <p
            className="collaboration-project-create-inline-error"
            role={announceGeneration ? 'alert' : undefined}
          >
            {groupGenerationError}
          </p>
        ) : null}
        {!groupGenerating && !groupEditorDraft ? (
          <ProjectComposerBody
            ref={generationComposerRef}
            translate={translate}
            value={groupGenerationInstructions}
            onChange={setGroupGenerationInstructions}
            onSubmit={value => void openGeneratedGroupDraft(value)}
            disabled={false}
            requireText
            embeddedInForm
            isModelSelectionReady={!generationModelsLoading && generationModels.length > 0}
            placeholder={labels.generationRequestPlaceholder}
            inputTestId="collaboration-project-create-generation-instructions"
            attachments={[]}
            uploadingCount={0}
            attachmentErrorCount={0}
            onFileSelect={() => {}}
            onRemoveAttachment={() => {}}
            renderAttachments={() => (
              <div
                className="mb-2 flex flex-wrap items-center gap-2"
                data-testid="collaboration-project-create-generation-agent-attachments"
              >
                {selectedAgents.map(agent => (
                  <span
                    key={agent.id}
                    className="inline-flex max-w-full items-center gap-2 rounded-md bg-muted px-2 py-1"
                  >
                    <span className="flex shrink-0 items-center justify-center text-text-secondary">
                      <Bot className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="flex min-w-0 flex-col text-left">
                      <strong
                        className="truncate text-sm font-medium text-text-primary"
                        title={agent.name}
                      >
                        {agent.name}
                      </strong>
                      <small className="sr-only">{labels.agentAttachment}</small>
                    </span>
                  </span>
                ))}
                {selectedGenerationHumans.map(member => (
                  <span
                    key={`human:${member.id}`}
                    className="inline-flex max-w-full items-center gap-2 rounded-md bg-muted px-2 py-1"
                  >
                    <span className="flex shrink-0 items-center justify-center text-text-secondary">
                      <UserRound className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="flex min-w-0 flex-col text-left">
                      <strong
                        className="truncate text-sm font-medium text-text-primary"
                        title={member.name}
                      >
                        {member.name}
                      </strong>
                      <small className="sr-only">{labels.memberAttachment}</small>
                    </span>
                  </span>
                ))}
              </div>
            )}
            renderEditor={editorProps => (
              <ComposerTextInput {...editorProps} ariaLabel={labels.generationRequest} />
            )}
            renderToolbar={toolbarProps => (
              <div
                className={`${toolbarProps.className} collaboration-project-create-generation-toolbar flex items-center justify-end gap-1.5`}
                data-testid="collaboration-project-create-generation-toolbar"
              >
                <ModelSelector
                  translate={translate}
                  isMobile={false}
                  emptyState={
                    <div
                      className="space-y-3 p-3"
                      data-testid="collaboration-project-create-model-empty"
                    >
                      <p
                        role={generationModelsError ? 'alert' : 'status'}
                        className="text-sm text-text-secondary"
                      >
                        {generationModelsError ??
                          (generationModelsLoading
                            ? labels.loadingGenerationModels
                            : labels.noGenerationModels)}
                      </p>
                      {resourceSetup?.loadCollaborationGroupGenerationModels && (
                        <ControlButton
                          variant="unstyled"
                          type="button"
                          data-testid="collaboration-project-create-reload-models"
                          className="collaboration-secondary-button min-h-11"
                          disabled={generationModelsLoading}
                          onClick={() => void reloadGenerationModels()}
                        >
                          {labels.reloadGenerationModels}
                        </ControlButton>
                      )}
                    </div>
                  }
                  models={unifiedGenerationModels}
                  selectedModel={selectedUnifiedGenerationModel}
                  selectedModelOptions={selectedGenerationModelOptions}
                  disabled={generationModelsLoading}
                  menuPlacement="above"
                  onOpenChange={setGenerationModelMenuOpen}
                  onSelectModel={model => {
                    if (!model) return false
                    const applied = selectGenerationModel({
                      modelName: model.name,
                      modelType: model.type,
                    })
                    if (!applied) return false
                    setGroupGenerationError(null)
                    return true
                  }}
                  onSelectModelAndOptions={(model, options) => {
                    const applied = selectGenerationModel(
                      {
                        modelName: model.name,
                        modelType: model.type,
                      },
                      options
                    )
                    if (!applied) return false
                    setGroupGenerationError(null)
                    return true
                  }}
                  onSelectModelOption={(optionId, value) =>
                    setSelectedGenerationModelOptions(current => ({
                      ...current,
                      [optionId]: value,
                    }))
                  }
                />
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-composer-primary-action="true"
                  data-testid="collaboration-project-create-generate-group"
                  disabled={!toolbarProps.canSend}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => toolbarProps.onSubmit()}
                  className="collaboration-primary-button shrink-0"
                  aria-label={labels.generateResponsibilities}
                >
                  {labels.generateResponsibilities}
                </ControlButton>
              </div>
            )}
          />
        ) : null}
        {groupGenerating || groupEditorDraft || hasPartialPreview ? (
          <div
            className={`collaboration-project-create-generation-progress${groupEditorDraft ? ' is-complete' : ''}`}
            data-testid={
              groupEditorDraft
                ? 'collaboration-project-create-group-editor'
                : 'collaboration-project-create-generation-progress'
            }
          >
            <header>
              {groupGenerating ? (
                <LoaderCircle aria-hidden="true" className="collaboration-spin" />
              ) : (
                <Sparkles aria-hidden="true" />
              )}
              <span>
                {groupEditorDraft ? (
                  <>
                    <strong>
                      <HoverEditableText
                        value={groupEditorDraft.name}
                        activateOnTextClick
                        showEditButton
                        testId="collaboration-project-create-group-name"
                        multiline={false}
                        ariaLabel={`${labels.editResponsibilities} ${labels.groupName}`}
                        onChange={name =>
                          setGroupEditorDraft(current => (current ? { ...current, name } : current))
                        }
                      />
                    </strong>
                    <small>{labels.groupDraftTitle}</small>
                  </>
                ) : (
                  <>
                    <strong>
                      {groupGenerating ? generationPhaseLabel : labels.partialGenerationPreview}
                    </strong>
                    {groupGenerating && (
                      <small>
                        {labels.generationElapsed.replace(
                          '{{seconds}}',
                          String(groupGenerationElapsedSeconds)
                        )}
                      </small>
                    )}
                  </>
                )}
              </span>
            </header>
            <div className="collaboration-project-create-squad-formation">
              {!groupEditorDraft && groupGenerating ? (
                <>
                  <div
                    className="collaboration-project-create-assignment-queue"
                    data-testid="collaboration-project-create-assignment-queue"
                  >
                    <header>
                      <span>
                        <Sparkles aria-hidden="true" />
                        <strong>{labels.waitingForAssignment}</strong>
                      </span>
                      <small>{labels.automaticAssignmentHint}</small>
                    </header>
                    <span>
                      {selectedAgents
                        .filter(agent => !assignedAgentIds.has(agent.id))
                        .map(agent => (
                          <span
                            key={agent.id}
                            className="is-waiting"
                            style={{
                              animationDelay: `${
                                selectedAgents.findIndex(candidate => candidate.id === agent.id) *
                                90
                              }ms`,
                            }}
                          >
                            <span className="collaboration-project-create-member-token">
                              <Bot aria-hidden="true" />
                              <strong>{agent.name}</strong>
                            </span>
                          </span>
                        ))}
                    </span>
                  </div>
                </>
              ) : null}
              <div className="is-squad">
                <small>{labels.formingGroup}</small>
                <CollaborationGroupRoster
                  locale={labels.locale}
                  testId="collaboration-project-create-group-roster"
                  participants={visibleGroupParticipants}
                  renderActions={participant =>
                    participant.draftParticipant && !participant.leader ? (
                      <ControlButton
                        variant="unstyled"
                        type="button"
                        className="collaboration-project-create-set-leader"
                        onClick={() => setGroupLeader(participant.draftParticipant!)}
                      >
                        {labels.setAsLeader}
                      </ControlButton>
                    ) : null
                  }
                  renderResponsibility={participant =>
                    !participant.leader &&
                    (participant.draftParticipant || participant.responsibility) ? (
                      <span className="collaboration-project-create-responsibility">
                        {participant.draftParticipant ? (
                          <HoverEditableText
                            value={participant.draftParticipant.responsibility}
                            placeholder={labels.supplementResponsibility}
                            ariaLabel={`${participant.name} ${labels.editResponsibilities}`}
                            onChange={responsibility =>
                              updateGroupParticipant(participant.draftParticipant!, responsibility)
                            }
                          />
                        ) : (
                          participant.responsibility
                        )}
                      </span>
                    ) : null
                  }
                />
              </div>
            </div>
            {groupEditorDraft ? (
              <div className="collaboration-project-create-generated-details">
                <section
                  className="collaboration-project-create-generated-principles"
                  data-testid="collaboration-project-create-group-instructions"
                >
                  <small>{labels.allocationPrinciples}</small>
                  <HoverEditableText
                    value={groupEditorDraft.instructions}
                    placeholder={labels.supplementAllocationPrinciples}
                    ariaLabel={`${labels.editResponsibilities} ${labels.allocationPrinciples}`}
                    onChange={instructions =>
                      setGroupEditorDraft(current =>
                        current ? { ...current, instructions } : current
                      )
                    }
                  />
                </section>
                {groupEditorDraft.stages.length > 0 ? (
                  <CollaborationGroupWorkflow
                    label={labels.generatedWorkflow}
                    pendingLabel={labels.generatingWorkflow}
                    stages={groupEditorDraft.stages}
                  />
                ) : null}
                <p className="collaboration-project-create-group-settings-hint">
                  {labels.groupSettingsHint}
                </p>
              </div>
            ) : (
              <div className="collaboration-project-create-live-output">
                {(groupGenerating || groupGenerationPrinciples.length > 0) && (
                  <section>
                    <small>{labels.allocationPrinciples}</small>
                    {groupGenerationPrinciples.length > 0 ? (
                      <ul>
                        {groupGenerationPrinciples.map((principle, index) => (
                          <li key={`${index}:${principle}`}>{principle}</li>
                        ))}
                      </ul>
                    ) : (
                      <span>{labels.generatingResponsibilities}</span>
                    )}
                  </section>
                )}
                {(groupGenerating || groupGenerationStages.length > 0) && (
                  <CollaborationGroupWorkflow
                    label={labels.generatedWorkflow}
                    pendingLabel={labels.generatingWorkflow}
                    stages={groupGenerationStages}
                    generating={groupGenerating}
                  />
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </ProjectCreateConfigurationView>
  )
}
