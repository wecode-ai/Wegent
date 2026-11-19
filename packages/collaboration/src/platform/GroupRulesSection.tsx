import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from '../controls/SelectParts'
import { normalizeSelectValue } from '../controls/selectValue'
import { Textarea as ControlTextarea } from '../controls/Textarea'
import { TextField as ControlInput } from '../controls/TextField'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0
import { GroupSettingsSection } from './GroupSettingsSection'
import type { GroupConfigurationModel } from './WorkspaceResourceConfiguration'

export function GroupRulesSection({ model }: { model: GroupConfigurationModel }) {
  const {
    canManage,
    candidates,
    displayName,
    draftInstructions,
    draftMembers,
    draftStages,
    executableDraftMemberIds,
    executableDraftMembers,
    insertRuleMention,
    locale,
    mentionOpen,
    messages,
    ruleEditorRef,
    setDraftInstructions,
    setDraftStages,
    setMentionOpen,
  } = model
  return (
    <GroupSettingsSection
      name="rules"
      label={messages.groupRule}
      summary={
        locale === 'zh-CN'
          ? `${draftStages.length} 个阶段${draftInstructions.trim() ? ' · 已填写规则' : ' · 未填写规则'}`
          : `${draftStages.length} stages${draftInstructions.trim() ? ' · Instructions set' : ' · No instructions'}`
      }
    >
      <div className="collaboration-group-rule-editor">
        <label className="block text-sm text-text-secondary">
          <span className="mb-1 block">{messages.groupRule}</span>
          <ControlTextarea
            ref={ruleEditorRef}
            data-testid="collaboration-group-detail-instructions"
            value={draftInstructions}
            disabled={!canManage}
            placeholder={
              locale === 'zh-CN'
                ? '说明如何协作，使用 @ 指定负责成员'
                : 'Describe how the group collaborates and use @ to assign members'
            }
            onChange={event => {
              const nextValue = event.target.value
              setDraftInstructions(nextValue)
              setMentionOpen(nextValue.endsWith('@'))
            }}
          />
        </label>
        <div className="collaboration-group-rule-editor-toolbar">
          <ControlButton
            variant="unstyled"
            type="button"
            className="collaboration-secondary-button"
            aria-expanded={mentionOpen}
            data-testid="collaboration-group-rule-mention-trigger"
            disabled={!canManage}
            onClick={() => setMentionOpen(current => !current)}
          >
            @ {locale === 'zh-CN' ? '提及成员' : 'Mention'}
          </ControlButton>
        </div>
        {mentionOpen ? (
          <div
            className="collaboration-group-rule-mention-menu"
            data-testid="collaboration-group-rule-mention-menu"
          >
            {draftMembers.map(member => {
              const candidate = candidates.find(
                item => item.kind === member.kind && item.id === member.id
              )
              if (!candidate) return null
              return (
                <ControlButton
                  variant="unstyled"
                  key={candidate.value}
                  type="button"
                  data-testid={`collaboration-group-rule-mention-${candidate.kind}-${candidate.id}`}
                  onClick={() => insertRuleMention(candidate)}
                >
                  <span>{candidate.name.slice(0, 1).toUpperCase()}</span>
                  <strong>{candidate.name}</strong>
                  <small>{member.responsibility}</small>
                </ControlButton>
              )
            })}
          </div>
        ) : null}
      </div>

      <div className="collaboration-group-reference-flow">
        <div className="collaboration-group-section-heading">
          <h3>
            {messages.stages}
            <small>{messages.stagesHint}</small>
          </h3>
          {canManage ? (
            <ControlButton
              variant="unstyled"
              type="button"
              className="collaboration-secondary-button"
              data-testid="collaboration-group-stage-add"
              onClick={() =>
                setDraftStages(current => [
                  ...current,
                  {
                    id: crypto.randomUUID(),
                    name:
                      locale === 'zh-CN'
                        ? `阶段 ${current.length + 1}`
                        : `Stage ${current.length + 1}`,
                    description: '',
                    assignee: null,
                  },
                ])
              }
            >
              + {messages.addStage}
            </ControlButton>
          ) : null}
        </div>
        {draftStages.length ? (
          <div className="collaboration-group-stage-flow">
            {draftStages.map((stage, index) => (
              <div
                key={stage.id}
                className="collaboration-group-stage-card"
                data-testid={`collaboration-group-stage-${stage.id}`}
              >
                <header>
                  <span>{index + 1}</span>
                  <ControlInput
                    value={stage.name}
                    disabled={!canManage}
                    aria-label={`${messages.stages} ${index + 1}`}
                    onChange={event =>
                      setDraftStages(current =>
                        current.map(candidate =>
                          candidate.id === stage.id
                            ? {
                                ...candidate,
                                name: event.target.value,
                              }
                            : candidate
                        )
                      )
                    }
                  />
                  {canManage ? (
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      className="collaboration-link-button collaboration-resource-remove"
                      aria-label={messages.remove}
                      onClick={() =>
                        setDraftStages(current =>
                          current.filter(candidate => candidate.id !== stage.id)
                        )
                      }
                    >
                      {messages.remove}
                    </ControlButton>
                  ) : null}
                </header>
                <div>
                  <label className="block min-w-0 text-xs text-text-secondary">
                    <span className="mb-1 block">
                      {locale === 'zh-CN' ? '阶段说明' : 'Stage description'}
                    </span>
                    <ControlTextarea
                      data-testid={`collaboration-group-stage-description-${stage.id}`}
                      aria-label={`${messages.stages} ${index + 1} ${locale === 'zh-CN' ? '说明' : 'description'}`}
                      value={stage.description}
                      disabled={!canManage}
                      placeholder={
                        locale === 'zh-CN'
                          ? '说明这一阶段要完成什么'
                          : 'Describe what this stage should accomplish'
                      }
                      onChange={event =>
                        setDraftStages(current =>
                          current.map(candidate =>
                            candidate.id === stage.id
                              ? {
                                  ...candidate,
                                  description: event.target.value,
                                }
                              : candidate
                          )
                        )
                      }
                    />
                  </label>
                  <label className="block min-w-0 text-xs text-text-secondary">
                    <span className="mb-1 block">{locale === 'zh-CN' ? '执行者' : 'Executor'}</span>
                    <SelectRoot
                      value={normalizeSelectValue(
                        stage.assignee &&
                          executableDraftMemberIds.has(
                            `${stage.assignee.kind}:${stage.assignee.id}`
                          )
                          ? `${stage.assignee.kind}:${stage.assignee.id}`
                          : ''
                      )}
                      disabled={!canManage}
                      onValueChange={selectedValue => {
                        if (selectedValue === null) return
                        const [kind, id] = selectedValue.split(':')
                        const member = draftMembers.find(
                          candidate => candidate.kind === kind && candidate.id === id
                        )
                        setDraftStages(current =>
                          current.map(candidate =>
                            candidate.id === stage.id
                              ? {
                                  ...candidate,
                                  assignee: member ? { ...member } : null,
                                }
                              : candidate
                          )
                        )
                      }}
                    >
                      <SelectTrigger
                        data-testid={`collaboration-group-stage-assignee-${stage.id}`}
                        aria-label={`${messages.stages} ${index + 1} ${locale === 'zh-CN' ? '执行者' : 'executor'}`}
                      />
                      <SelectContent>
                        <SelectItem value="">{messages.leaderAssignment}</SelectItem>
                        {executableDraftMembers.map(member => (
                          <SelectItem
                            key={`${member.kind}:${member.id}`}
                            value={String(`${member.kind}:${member.id}`)}
                          >
                            @{displayName(member.kind, member.id)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </SelectRoot>
                  </label>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </GroupSettingsSection>
  )
}
