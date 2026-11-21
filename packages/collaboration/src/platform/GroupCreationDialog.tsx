import { useRef } from 'react'
import { DialogSurface } from '../controls/DialogSurface'
import { TextField as ControlInput } from '../controls/TextField'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { X } from 'lucide-react'
import { DialogForm } from '../controls/DialogForm'
import { applyTemplateGroups } from '../templates/apply'
import { GroupTemplateCreator } from '../templates/GroupTemplateCreator'
import { templateMessages } from '../templates/messages'
import { GroupConfigurationError as ErrorMessage } from './GroupConfigurationFeedback'
import { GroupParticipantsEditor } from './GroupParticipantsEditor'
import type { GroupConfigurationModel } from './WorkspaceResourceConfiguration'

export function GroupCreationDialog({ model }: { model: GroupConfigurationModel }) {
  const {
    agentActionBusy,
    agentConfiguration,
    candidates,
    commands,
    createMembers,
    currentUserId,
    description,
    error,
    groupAgentActions,
    groups,
    leader,
    locale,
    messages,
    name,
    participantsPending,
    persistedMemberName,
    saving,
    setCreateMembers,
    setDescription,
    setError,
    setFormOpen,
    setLeader,
    setName,
    setSaving,
    setSelectedGroupId,
    updateCreateMemberResponsibility,
    updateCreateMemberSelection,
    withCandidateName,
    workspace,
  } = model
  const dialogRef = useRef<HTMLFormElement>(null)
  return (
    <div
      className="collaboration-dialog-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !saving) {
          setFormOpen(false)
        }
      }}
    >
      <DialogSurface
        onClose={() => {
          if (saving) return
          setFormOpen(false)
          setError(null)
        }}
        render={
          <DialogForm
            ref={dialogRef}
            aria-labelledby="collaboration-group-create-heading"
            tabIndex={-1}
            className="collaboration-dialog collaboration-resource-dialog collaboration-group-create-dialog"
            data-testid="collaboration-group-form"
            onSubmit={event => {
              event.preventDefault()
              if (!name.trim() || !leader) return
              const [leaderKind, leaderId] = leader.split(':')
              setSaving(true)
              setError(null)
              void commands
                .createCollaborationGroup({
                  name: name.trim(),
                  description: description.trim(),
                  leader: {
                    kind: leaderKind as 'human' | 'agent',
                    id: leaderId,
                    name: persistedMemberName(leaderKind as 'human' | 'agent', leaderId),
                    responsibility: '',
                  },
                  members: [
                    withCandidateName({
                      kind: leaderKind as 'human' | 'agent',
                      id: leaderId,
                      responsibility: '',
                    }),
                    ...createMembers
                      .filter(member => `${member.kind}:${member.id}` !== leader)
                      .map(withCandidateName),
                  ],
                  coordinationMode: 'manager',
                  instructions: '',
                  stages: [],
                  executionRequirements: { requiredTags: [] },
                })
                .then(created => {
                  if (!dialogRef.current?.isConnected) return
                  setName('')
                  setDescription('')
                  setLeader('')
                  setCreateMembers([])
                  setFormOpen(false)
                  setSelectedGroupId(created.id)
                })
                .catch(() => setError(messages.operationFailed))
                .finally(() => setSaving(false))
            }}
          />
        }
      >
        <div className="collaboration-group-create-heading">
          <div>
            <h3 id="collaboration-group-create-heading">{messages.createGroup}</h3>
            <p>
              {leader
                ? locale === 'zh-CN'
                  ? '已选择负责人，可在成员列表中调整。'
                  : 'A leader is selected and can be changed in the member list.'
                : locale === 'zh-CN'
                  ? '添加参与者并指定负责人后，即可创建小组。'
                  : 'Add participants and choose a leader to create the group.'}
            </p>
          </div>
          <ControlButton
            variant="unstyled"
            type="button"
            className="collaboration-group-create-close"
            data-testid="collaboration-group-create-close"
            aria-label={locale === 'zh-CN' ? '关闭' : 'Close'}
            showTooltip={false}
            disabled={saving}
            onClick={() => {
              setFormOpen(false)
              setError(null)
              setCreateMembers([])
              setLeader('')
            }}
          >
            <X size={18} aria-hidden="true" />
          </ControlButton>
        </div>
        <div className="collaboration-group-create-layout">
          <div className="collaboration-group-create-main">
            <div className="collaboration-group-create-content">
              <section className="collaboration-group-create-panel">
                <GroupTemplateCreator
                  modelConfiguration={
                    agentConfiguration && workspace
                      ? {
                          host: agentConfiguration,
                          location: workspace.location,
                        }
                      : undefined
                  }
                  locale={locale}
                  candidates={candidates.map(candidate => ({
                    ...candidate,
                    label: candidate.name,
                    responsibility: '',
                  }))}
                  currentUserId={currentUserId}
                  existingNames={groups.map(group => group.name)}
                  disabled={saving || participantsPending}
                  onApply={async (drafts, document, resolveRouting) => {
                    const created = commands.createTemplateGroups
                      ? await commands.createTemplateGroups(document, drafts, resolveRouting)
                      : await applyTemplateGroups(
                          drafts,
                          draft =>
                            commands.createCollaborationGroup({
                              ...draft,
                              coordinationMode: 'manager',
                            }),
                          templateMessages[locale].partial
                        )
                    if (!dialogRef.current?.isConnected) return
                    setFormOpen(false)
                    setSelectedGroupId(created.at(-1)?.id ?? null)
                  }}
                />
                <div className="collaboration-group-field-grid collaboration-group-create-fields">
                  <label>
                    <span>{messages.groupName}</span>
                    <ControlInput
                      data-testid="collaboration-group-name"
                      value={name}
                      autoFocus
                      onChange={event => setName(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>{messages.groupDescription}</span>
                    <ControlInput
                      data-testid="collaboration-group-description"
                      value={description}
                      placeholder={
                        locale === 'zh-CN'
                          ? '简要说明这个小组负责什么'
                          : 'Briefly describe what this group owns'
                      }
                      onChange={event => setDescription(event.target.value)}
                    />
                  </label>
                </div>
                <GroupParticipantsEditor
                  candidates={candidates}
                  leader={leader}
                  members={createMembers}
                  locale={locale}
                  compact
                  agentActions={agentActionBusy ? [] : groupAgentActions}
                  onLeaderChange={candidate => {
                    if (candidate.value === leader) return
                    const previous = candidates.find(item => item.value === leader)
                    setCreateMembers(current => {
                      const next = [...current]
                      for (const participant of [previous, candidate]) {
                        if (
                          participant &&
                          !next.some(member => `${member.kind}:${member.id}` === participant.value)
                        ) {
                          next.push({
                            kind: participant.kind,
                            id: participant.id,
                            responsibility: '',
                          })
                        }
                      }
                      return next.map(member =>
                        `${member.kind}:${member.id}` === candidate.value
                          ? { ...member, responsibility: '' }
                          : member
                      )
                    })
                    setLeader(candidate.value)
                  }}
                  onMemberChange={updateCreateMemberSelection}
                  onResponsibilityChange={updateCreateMemberResponsibility}
                />
              </section>
            </div>

            <div className="collaboration-resource-form-actions collaboration-group-create-actions">
              <ControlButton
                variant="unstyled"
                type="button"
                className="collaboration-link-button"
                data-testid="collaboration-group-create-cancel"
                disabled={saving}
                onClick={() => {
                  setFormOpen(false)
                  setError(null)
                  setCreateMembers([])
                  setLeader('')
                }}
              >
                {messages.cancel}
              </ControlButton>
              <span />
              <ControlButton
                variant="unstyled"
                type="submit"
                className="collaboration-primary-button"
                data-testid="collaboration-group-create"
                disabled={saving || participantsPending || !name.trim() || !leader}
              >
                {messages.createGroup}
              </ControlButton>
            </div>
            <ErrorMessage message={error} />
          </div>
        </div>
      </DialogSurface>
    </div>
  )
}
