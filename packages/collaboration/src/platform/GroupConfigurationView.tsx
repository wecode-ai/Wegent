import { useRef } from 'react'
import { DialogSurface } from '../controls/DialogSurface'
import { Textarea as ControlTextarea } from '../controls/Textarea'
import { TextField as ControlInput } from '../controls/TextField'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { useState } from 'react'
import { ConfirmationDialog } from '../controls/ConfirmationDialog'
import { DialogForm } from '../controls/DialogForm'
import { GroupTemplateActions } from '../templates/GroupTemplateActions'
import { templateMessages } from '../templates/messages'
import { GroupConfigurationError as ErrorMessage } from './GroupConfigurationFeedback'
import { GroupCreationDialog } from './GroupCreationDialog'
import { GroupParticipantsEditor } from './GroupParticipantsEditor'
import { GroupRulesSection } from './GroupRulesSection'
import { GroupSettingsSection } from './GroupSettingsSection'
import { PanelFeedback } from './usePanelData'
import type { GroupConfigurationModel } from './WorkspaceResourceConfiguration'

export function GroupConfigurationView({ model }: { model: GroupConfigurationModel }) {
  const {
    addCreatedAgent,
    addRequiredEnvironmentTag,
    agentActionBusy,
    agentActions,
    agentCreatorOpen,
    availableGroups,
    canManage,
    candidates,
    collaborationGroupAgentId,
    commands,
    copyAgentOpen,
    copyableAgents,
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
    formOpen,
    groupAgentActions,
    groups,
    collectionState,
    loadParticipants,
    locale,
    messages,
    onDetailClose,
    participants,
    participantsPending,
    pendingRemoval,
    persistedMemberName,
    restoreGroupDraft,
    saving,
    selectedGroup,
    selectedGroupId,
    setAgentActionBusy,
    setAgentCreatorOpen,
    setCopyAgentOpen,
    setDraftDescription,
    setDraftLeader,
    setDraftMembers,
    setDraftName,
    setDraftRequiredEnvironmentTags,
    setDraftStages,
    setEnvironmentTagInput,
    setError,
    setFormOpen,
    setPendingRemoval,
    setSaving,
    setSelectedGroupId,
    showGroupCollection,
    templateStore,
    translate,
    updateMemberSelection,
    withCandidateName,
    workspace,
  } = model

  const [pendingDraftExit, setPendingDraftExit] = useState(false)
  const closeGroup = () => (onDetailClose ? onDetailClose() : setSelectedGroupId(null))
  const copyDialogRef = useRef<HTMLElement>(null)

  const content = (
    <>
      {pendingDraftExit && selectedGroup ? (
        <ConfirmationDialog
          title={locale === 'zh-CN' ? '放弃未保存的更改？' : 'Discard unsaved changes?'}
          subject={selectedGroup.name}
          description={
            locale === 'zh-CN'
              ? '返回列表会放弃当前小组的未保存更改。继续编辑可以保留它们。'
              : "Returning to the list discards this group's unsaved changes. Continue editing to keep them."
          }
          labels={{
            cancel: locale === 'zh-CN' ? '继续编辑' : 'Continue editing',
            confirm: locale === 'zh-CN' ? '放弃并返回' : 'Discard and return',
            pending: messages.cancel,
            failed: messages.operationFailed,
          }}
          testIdPrefix="collaboration-group-unsaved"
          onClose={() => setPendingDraftExit(false)}
          onConfirm={async () => {
            setPendingDraftExit(false)
            closeGroup()
          }}
        />
      ) : null}
      {pendingRemoval && (
        <ConfirmationDialog
          key={`${pendingRemoval.prefix}:${pendingRemoval.group.id}`}
          title={
            workspace || pendingRemoval.group.owner_type === 'project'
              ? messages.deleteGroup
              : messages.removeFromProject
          }
          subject={pendingRemoval.group.name}
          description={
            workspace || pendingRemoval.group.owner_type === 'project'
              ? messages.deleteGroupConfirm
              : messages.removeGroupConfirm
          }
          labels={{
            cancel: messages.cancel,
            confirm:
              workspace || pendingRemoval.group.owner_type === 'project'
                ? messages.deleteProjectGroup
                : messages.remove,
            pending: messages.deleting,
            failed: messages.operationFailed,
          }}
          testIdPrefix={pendingRemoval.prefix}
          onClose={() => setPendingRemoval(null)}
          onConfirm={async () => {
            await commands.removeCollaborationGroup(pendingRemoval.group.id)
            if (selectedGroupId === pendingRemoval.group.id) {
              setSelectedGroupId(null)
              onDetailClose?.()
            }
          }}
        />
      )}
      {selectedGroup ? (
        <div
          className={`collaboration-group-detail${
            detailPresentation === 'dialog' ? ' collaboration-group-detail-dialog' : ''
          }`}
          key={selectedGroup.id}
          data-testid={`collaboration-group-detail-${selectedGroup.id}`}
        >
          {detailPresentation === 'page' ? (
            <div className="collaboration-resource-heading flex-wrap gap-y-3">
              <div>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  className="collaboration-link-button collaboration-group-back"
                  data-testid="collaboration-group-detail-back"
                  onClick={() => (dirty && !saving ? setPendingDraftExit(true) : closeGroup())}
                >
                  ← {messages.backToGroups}
                </ControlButton>
                <h2>{selectedGroup.name}</h2>
                {selectedGroup.owner_type === 'workspace' ? <p>{messages.workspaceOwned}</p> : null}
              </div>
            </div>
          ) : null}
          <DialogForm
            className="collaboration-group-detail-form"
            onSubmit={event => {
              event.preventDefault()
              if (
                !commands.updateCollaborationGroup ||
                !draftName.trim() ||
                !draftLeader ||
                draftMembers.length === 0
              ) {
                return
              }
              const [leaderKind, leaderId] = draftLeader.split(':')
              setSaving(true)
              setError(null)
              void commands
                .updateCollaborationGroup(selectedGroup.id, {
                  version: selectedGroup.version,
                  name: draftName.trim(),
                  description: draftDescription.trim(),
                  instructions: draftInstructions.trim(),
                  leader: {
                    kind: leaderKind as 'human' | 'agent',
                    id: leaderId,
                    name: persistedMemberName(
                      leaderKind as 'human' | 'agent',
                      leaderId,
                      selectedGroup.leader.kind === leaderKind &&
                        selectedGroup.leader.id === leaderId
                        ? selectedGroup.leader.name
                        : undefined
                    ),
                    responsibility: '',
                  },
                  members: draftMembers.map(member =>
                    member.kind === leaderKind && member.id === leaderId
                      ? withCandidateName({ ...member, responsibility: '' })
                      : withCandidateName(member)
                  ),
                  coordinationMode: 'manager',
                  stages: draftStages.map(stage => ({
                    ...stage,
                    assignee:
                      stage.assignee &&
                      executableDraftMemberIds.has(`${stage.assignee.kind}:${stage.assignee.id}`)
                        ? stage.assignee
                        : null,
                  })),
                  executionRequirements: {
                    requiredTags: draftRequiredEnvironmentTags,
                  },
                })
                .catch(() => setError(messages.operationFailed))
                .finally(() => setSaving(false))
            }}
          >
            <aside className="collaboration-group-detail-section collaboration-group-detail-profile">
              {detailPresentation === 'dialog' ? (
                <div className="collaboration-group-dialog-section-title">
                  <h3>{locale === 'zh-CN' ? '基本信息' : 'Basics'}</h3>
                  <span>
                    {selectedGroup.owner_type === 'project'
                      ? messages.projectOwned
                      : messages.workspaceOwned}
                  </span>
                </div>
              ) : null}
              <div className="collaboration-group-profile-fields">
                <label>
                  <span>{messages.groupName}</span>
                  <ControlInput
                    data-testid="collaboration-group-detail-name"
                    value={draftName}
                    disabled={!canManage}
                    onChange={event => setDraftName(event.target.value)}
                  />
                </label>
                <label>
                  <span>{messages.groupDescription}</span>
                  <ControlTextarea
                    data-testid="collaboration-group-detail-description"
                    value={draftDescription}
                    disabled={!canManage}
                    onChange={event => setDraftDescription(event.target.value)}
                  />
                </label>
              </div>
            </aside>

            <div className="collaboration-group-detail-main">
              <GroupSettingsSection
                name="members"
                label={messages.membersLabel}
                summary={draftMembers.length + (locale === 'zh-CN' ? ' 位参与者' : ' participants')}
                defaultOpen
              >
                <GroupParticipantsEditor
                  inline
                  readOnly={!canManage}
                  candidates={candidates}
                  leader={draftLeader}
                  members={draftMembers}
                  locale={locale}
                  agentActions={canManage && !agentActionBusy ? groupAgentActions : []}
                  onLeaderChange={candidate => {
                    updateMemberSelection(candidate, true)
                    setDraftMembers(current =>
                      current.map(member =>
                        member.kind === candidate.kind && member.id === candidate.id
                          ? { ...member, responsibility: '' }
                          : member
                      )
                    )
                    setDraftLeader(candidate.value)
                    setDraftStages(current =>
                      current.map(stage =>
                        stage.assignee?.kind === candidate.kind &&
                        stage.assignee.id === candidate.id
                          ? { ...stage, assignee: null }
                          : stage
                      )
                    )
                  }}
                  onMemberChange={updateMemberSelection}
                  onResponsibilityChange={(candidate, responsibility) =>
                    setDraftMembers(current =>
                      current.map(member =>
                        member.kind === candidate.kind && member.id === candidate.id
                          ? { ...member, responsibility }
                          : member
                      )
                    )
                  }
                />
              </GroupSettingsSection>

              <GroupRulesSection model={model} />

              <GroupSettingsSection
                name="environment"
                label={messages.environmentRequirements}
                summary={
                  draftRequiredEnvironmentTags.length
                    ? draftRequiredEnvironmentTags.join(' · ')
                    : locale === 'zh-CN'
                      ? '不限环境'
                      : 'Any environment'
                }
              >
                <div className="collaboration-group-section-heading">
                  <h3>{messages.environmentRequirements}</h3>
                </div>
                <label>
                  <span>{messages.requiredEnvironmentTags}</span>
                  <div className="collaboration-group-environment-tag-input">
                    <ControlInput
                      data-testid="collaboration-group-environment-tag-input"
                      value={environmentTagInput}
                      disabled={!canManage}
                      placeholder={messages.environmentTagPlaceholder}
                      onChange={event => setEnvironmentTagInput(event.target.value)}
                      onKeyDown={event => {
                        if (event.key !== 'Enter') return
                        event.preventDefault()
                        addRequiredEnvironmentTag()
                      }}
                    />
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      className="collaboration-secondary-button"
                      data-testid="collaboration-group-environment-tag-add"
                      disabled={!canManage || !environmentTagInput.trim()}
                      onClick={addRequiredEnvironmentTag}
                    >
                      {locale === 'zh-CN' ? '添加' : 'Add'}
                    </ControlButton>
                  </div>
                </label>
                {draftRequiredEnvironmentTags.length ? (
                  <div className="collaboration-group-environment-tags">
                    {draftRequiredEnvironmentTags.map(tag => (
                      <span key={tag}>
                        {tag}
                        {canManage ? (
                          <ControlButton
                            variant="unstyled"
                            type="button"
                            aria-label={`${messages.remove} ${tag}`}
                            data-testid={`collaboration-group-environment-tag-remove-${tag}`}
                            onClick={() =>
                              setDraftRequiredEnvironmentTags(current =>
                                current.filter(candidate => candidate !== tag)
                              )
                            }
                          >
                            {messages.remove}
                          </ControlButton>
                        ) : null}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="collaboration-group-inline-empty">
                    {locale === 'zh-CN' ? '不限环境' : 'Any environment'}
                  </div>
                )}
              </GroupSettingsSection>
              {templateStore && commands.loadTemplateAgents ? (
                <GroupSettingsSection
                  name="sharing"
                  label={templateMessages[locale].configuration}
                  summary={
                    locale === 'zh-CN' ? '保存或导出小组配置' : 'Save or export group configuration'
                  }
                >
                  <GroupTemplateActions
                    group={selectedGroup}
                    hasUnsavedChanges={dirty}
                    locale={locale}
                    loadAgents={commands.loadTemplateAgents}
                  />
                </GroupSettingsSection>
              ) : null}
              <ErrorMessage message={error} />
              {canManage && commands.updateCollaborationGroup ? (
                <div className="collaboration-resource-form-actions collaboration-group-save-actions">
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    className="collaboration-link-button collaboration-resource-remove"
                    data-testid="collaboration-group-detail-delete"
                    disabled={saving}
                    onClick={() =>
                      setPendingRemoval({
                        group: selectedGroup,
                        prefix: 'collaboration-group-detail-delete',
                      })
                    }
                  >
                    {messages.deleteGroup}
                  </ControlButton>
                  <span
                    className="collaboration-group-save-status"
                    role="status"
                    data-testid="collaboration-group-save-status"
                  >
                    {saving
                      ? locale === 'zh-CN'
                        ? '正在保存配置…'
                        : 'Saving configuration…'
                      : dirty
                        ? locale === 'zh-CN'
                          ? '有未保存的更改'
                          : 'Unsaved changes'
                        : locale === 'zh-CN'
                          ? '配置已保存'
                          : 'Configuration saved'}
                  </span>
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    className="collaboration-secondary-button"
                    data-testid="collaboration-group-detail-discard"
                    disabled={saving || !dirty}
                    onClick={() => restoreGroupDraft(selectedGroup)}
                  >
                    {locale === 'zh-CN' ? '放弃修改' : 'Discard changes'}
                  </ControlButton>
                  <ControlButton
                    variant="unstyled"
                    type="submit"
                    className="collaboration-primary-button"
                    data-testid="collaboration-group-detail-save"
                    disabled={
                      saving ||
                      participantsPending ||
                      !draftName.trim() ||
                      !draftLeader ||
                      draftMembers.length === 0
                    }
                  >
                    {saving ? (locale === 'zh-CN' ? '保存中…' : 'Saving…') : messages.saveGroup}
                  </ControlButton>
                </div>
              ) : null}
            </div>
          </DialogForm>
        </div>
      ) : (
        <>
          {showGroupCollection ? (
            <div className="collaboration-resource-heading">
              <div>
                <h2>{messages.collaborationGroups}</h2>
                <p>{messages.collaborationGroupHint}</p>
              </div>
              {canManage ? (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  className={
                    workspace
                      ? 'collaboration-primary-button shrink-0 whitespace-nowrap'
                      : 'collaboration-secondary-button shrink-0 whitespace-nowrap'
                  }
                  data-testid="collaboration-group-open-create"
                  onClick={() => setFormOpen(true)}
                >
                  {messages.createGroup}
                </ControlButton>
              ) : null}
            </div>
          ) : null}
          {canManage && formOpen ? <GroupCreationDialog model={model} /> : null}
          {showGroupCollection ? (
            <>
              <div className={workspace ? undefined : 'collaboration-resource-section'}>
                {groups.length ? (
                  <div className="collaboration-group-card-grid">
                    {groups.map(group => (
                      <article
                        key={group.id}
                        className="collaboration-group-card"
                        data-testid={`collaboration-group-${group.id}`}
                      >
                        <div className="collaboration-group-card-header">
                          <span className="collaboration-resource-avatar">
                            {group.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span>
                            <strong>{group.name}</strong>
                            <small>
                              {group.owner_type === 'project'
                                ? messages.projectOwned
                                : messages.workspaceOwned}
                            </small>
                          </span>
                        </div>
                        <div className="collaboration-group-card-summary">
                          <p>
                            {group.description ||
                              (locale === 'zh-CN'
                                ? '暂未填写协作目标'
                                : 'No collaboration goal yet')}
                          </p>
                          <div className="collaboration-group-card-meta">
                            <span>
                              {messages.leader}：{displayName(group.leader.kind, group.leader.id)}
                            </span>
                            <span>
                              {group.members.length} {messages.membersLabel}
                            </span>
                            <span>
                              {group.stages.length
                                ? `${group.stages.length} ${messages.stages}`
                                : messages.leaderAssignment}
                            </span>
                          </div>
                        </div>
                        <div className="collaboration-resource-actions">
                          <ControlButton
                            variant="unstyled"
                            type="button"
                            className="collaboration-secondary-button"
                            data-testid={`collaboration-group-manage-${group.id}`}
                            onClick={() => setSelectedGroupId(group.id)}
                          >
                            {messages.manageGroup}
                          </ControlButton>
                          {canManage ? (
                            <ControlButton
                              variant="unstyled"
                              type="button"
                              className="collaboration-link-button collaboration-resource-remove"
                              data-testid={`collaboration-group-remove-${group.id}`}
                              onClick={() =>
                                setPendingRemoval({
                                  group,
                                  prefix: 'collaboration-group-delete',
                                })
                              }
                            >
                              {workspace
                                ? messages.remove
                                : group.owner_type === 'project'
                                  ? messages.deleteProjectGroup
                                  : messages.removeFromProject}
                            </ControlButton>
                          ) : null}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : collectionState === 'ready' ? (
                  <div className="collaboration-resource-empty">
                    {workspace ? messages.noGroups : messages.noProjectGroups}
                  </div>
                ) : collectionState === 'loading' ? (
                  <p className="py-5 text-sm text-text-secondary" role="status">
                    {locale === 'zh-CN' ? '正在加载协作小组…' : 'Loading collaboration groups…'}
                  </p>
                ) : null}
              </div>
              {availableGroups.length > 0 && commands.addCollaborationGroup ? (
                <div className="collaboration-resource-section">
                  <h3>{messages.availableWorkspaceGroups}</h3>
                  <div className="collaboration-group-card-grid">
                    {availableGroups.map(group => (
                      <article
                        key={group.id}
                        className="collaboration-group-card compact"
                        data-testid={`collaboration-group-available-${group.id}`}
                      >
                        <div className="collaboration-group-card-header">
                          <span className="collaboration-resource-avatar">
                            {group.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span>
                            <strong>{group.name}</strong>
                            <small>{messages.workspaceOwned}</small>
                          </span>
                        </div>
                        {canManage ? (
                          <ControlButton
                            variant="unstyled"
                            type="button"
                            className="collaboration-secondary-button"
                            data-testid={`collaboration-group-add-${group.id}`}
                            onClick={() => {
                              setError(null)
                              void commands
                                .addCollaborationGroup?.(group.id)
                                .catch(() => setError(messages.operationFailed))
                            }}
                          >
                            {locale === 'zh-CN' ? '添加到项目' : 'Add to project'}
                          </ControlButton>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}
              <ErrorMessage message={error} />
            </>
          ) : null}
        </>
      )}
      {agentCreatorOpen && agentActions?.renderCreator
        ? agentActions.renderCreator({
            onClose: () => setAgentCreatorOpen(false),
            onCreated: async agent => {
              addCreatedAgent(agent)
              setAgentCreatorOpen(false)
            },
          })
        : null}
      {copyAgentOpen ? (
        <div
          className="collaboration-dialog-backdrop"
          role="presentation"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !agentActionBusy) {
              setCopyAgentOpen(false)
            }
          }}
        >
          <DialogSurface
            onClose={() => {
              if (!agentActionBusy) setCopyAgentOpen(false)
            }}
            active={copyAgentOpen}
            render={
              <section
                className="collaboration-dialog collaboration-resource-dialog collaboration-group-copy-agent-dialog"
                aria-label={messages.copyAgentTitle}
                ref={copyDialogRef}
                tabIndex={-1}
                data-testid="collaboration-group-copy-agent-dialog"
              />
            }
          >
            <h2>{messages.copyAgentTitle}</h2>
            {copyableAgents.length ? (
              <div className="collaboration-resource-candidates">
                {copyableAgents.map(agent => {
                  const agentId = collaborationGroupAgentId(agent)
                  return (
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      key={agentId}
                      disabled={agentActionBusy}
                      data-testid={`collaboration-group-copy-agent-${agentId}`}
                      onClick={() => {
                        setAgentActionBusy(true)
                        setError(null)
                        void agentActions
                          ?.copy?.(agent)
                          .then(created => {
                            addCreatedAgent(created)
                            setCopyAgentOpen(false)
                          })
                          .catch(() => setError(messages.operationFailed))
                          .finally(() => setAgentActionBusy(false))
                      }}
                    >
                      <span className="collaboration-resource-avatar">
                        {agent.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span>
                        <strong>{agent.name}</strong>
                        <small>{messages.copyAgentHint}</small>
                      </span>
                    </ControlButton>
                  )
                })}
              </div>
            ) : (
              <div className="collaboration-resource-empty">{messages.noCopyableAgents}</div>
            )}
            <footer>
              <ControlButton
                variant="unstyled"
                type="button"
                className="collaboration-secondary-button"
                disabled={agentActionBusy}
                onClick={() => setCopyAgentOpen(false)}
              >
                {messages.cancel}
              </ControlButton>
            </footer>
          </DialogSurface>
        </div>
      ) : null}
    </>
  )

  if (!showGroupCollection && !selectedGroup) {
    return content
  }

  return (
    <section
      className={
        detailPresentation === 'dialog'
          ? 'collaboration-group-dialog-content'
          : 'collaboration-group-settings'
      }
    >
      {loadParticipants && (formOpen || selectedGroupId) ? (
        <PanelFeedback
          state={participants}
          translate={translate}
          testId="workspace-group-participants"
        />
      ) : null}
      {content}
    </section>
  )
}
