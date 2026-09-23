// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { DialogForm } from "../controls/DialogForm";

import * as Popover from "@radix-ui/react-popover";
import {
  Bot,
  ChevronDown,
  Cloud,
  GitBranch,
  Grid3X3,
  HardDrive,
  ListTodo,
  LockKeyhole,
  Plus,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useCollaborationPortalTheme } from "../theme";
import type {
  ProjectCreateDialogProps,
  ProjectCreateModalProps,
} from "./types";
import { useProjectCreateController } from "./useProjectCreateController";

function DefaultModal({ title, children, onClose }: ProjectCreateModalProps) {
  return (
    <div className="collaboration-dialog-backdrop">
      <section
        className="collaboration-dialog collaboration-project-create-dialog"
        role="dialog"
        aria-modal="true"
        data-testid="collaboration-project-create-dialog"
      >
        <header className="collaboration-project-create-header">
          <h2>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            <X aria-hidden="true" />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function ChoiceButton({
  testId,
  selected,
  icon,
  label,
  description,
  onClick,
}: {
  testId: string;
  selected: boolean;
  icon: ReactNode;
  label: string;
  description: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={selected}
      onClick={onClick}
      className={`collaboration-project-create-choice${selected ? " is-selected" : ""}`}
    >
      {icon}
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </button>
  );
}

function CollaboratorToken({
  icon,
  label,
  onRemove,
  removeLabel,
}: {
  icon: ReactNode;
  label: string;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <span className="collaboration-project-create-collaborator-token">
      {icon}
      <span>{label}</span>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={removeLabel}>
          <X aria-hidden="true" />
        </button>
      ) : null}
    </span>
  );
}

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
  } = props;
  const { state, commands } = useProjectCreateController(props);
  const portalTheme = useCollaborationPortalTheme();
  const [collaboratorPickerOpen, setCollaboratorPickerOpen] = useState(false);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [defaultAgentCreating, setDefaultAgentCreating] = useState(false);
  const [groupSelectionActive, setGroupSelectionActive] = useState(false);
  const [collaboratorError, setCollaboratorError] = useState<string | null>(
    null,
  );
  const createDefaultAgent = async () => {
    if (!resourceSetup?.createDefaultAgent || defaultAgentCreating) return;
    setDefaultAgentCreating(true);
    setCollaboratorError(null);
    try {
      const resourceId = await resourceSetup.createDefaultAgent();
      commands.setMemberUserIds([]);
      commands.setAgentResourceIds([resourceId]);
      commands.setLeaderId(`agent:${resourceId}`);
      setGroupSelectionActive(true);
      setCollaboratorPickerOpen(false);
    } catch (cause) {
      setCollaboratorError(
        host?.formatError?.(cause) ??
          (cause instanceof Error ? cause.message : labels.createFailed),
      );
    } finally {
      setDefaultAgentCreating(false);
    }
  };
  const selectedMembers =
    resourceSetup?.members.filter(
      (member) =>
        member.user_id !== resourceSetup.currentUser.id &&
        state.memberUserIds.includes(member.user_id),
    ) ?? [];
  const selectedAgents =
    resourceSetup?.agents.filter((agent) =>
      state.agentResourceIds.includes(agent.id),
    ) ?? [];
  const removeGroup = () => {
    commands.setMemberUserIds([]);
    commands.setAgentResourceIds([]);
    commands.setLeaderId("");
    setGroupSelectionActive(false);
  };
  const removeMember = (userId: number) => {
    if (groupSelectionActive) {
      removeGroup();
      return;
    }
    commands.setMemberUserIds(
      state.memberUserIds.filter((candidate) => candidate !== userId),
    );
    if (state.leaderId === `user:${userId}`) commands.setLeaderId("");
  };
  const removeAgent = (resourceId: string) => {
    if (groupSelectionActive) {
      removeGroup();
      return;
    }
    commands.setAgentResourceIds(
      state.agentResourceIds.filter((candidate) => candidate !== resourceId),
    );
    if (state.leaderId === `agent:${resourceId}`) commands.setLeaderId("");
  };
  const importGroup = (groupId: string) => {
    const group = resourceSetup?.groups.find(
      (candidate) => candidate.id === groupId,
    );
    if (!group || !resourceSetup) return;
    const groupParticipants = [group.leader, ...group.members].filter(
      (participant, index, participants) =>
        participants.findIndex(
          (candidate) =>
            candidate.kind === participant.kind &&
            candidate.id === participant.id,
        ) === index,
    );
    const humanIds = groupParticipants
      .filter((member) => member.kind === "human")
      .map((member) => Number(member.id))
      .filter(
        (userId) =>
          Number.isFinite(userId) && userId !== resourceSetup.currentUser.id,
      );
    const agentIds = groupParticipants
      .filter((member) => member.kind === "agent")
      .map((member) => member.id)
      .filter((id) => resourceSetup.agents.some((agent) => agent.id === id));
    commands.setMemberUserIds(humanIds);
    commands.setAgentResourceIds(agentIds);
    const leaderId =
      group.leader.kind === "human"
        ? `user:${group.leader.id}`
        : `agent:${group.leader.id}`;
    if (
      leaderId === `user:${resourceSetup.currentUser.id}` ||
      humanIds.some((id) => leaderId === `user:${id}`) ||
      agentIds.some((id) => leaderId === `agent:${id}`)
    ) {
      commands.setLeaderId(leaderId);
    }
    setGroupSelectionActive(true);
    setCollaboratorPickerOpen(false);
  };
  const renderModal =
    host?.renderModal ?? ((modalProps) => <DefaultModal {...modalProps} />);
  const cloudLocationDescription = workspaceContext
    ? `${workspaceContext.name} · ${workspaceContext.owner}`
    : labels.cloudLocationDescription;
  const providers = [
    {
      id: "local" as const,
      icon: <ListTodo aria-hidden="true" />,
      label: labels.builtInProvider,
      description:
        state.location === "local"
          ? labels.builtInLocalDescription
          : labels.builtInCloudDescription,
    },
    {
      id: "github" as const,
      icon: <GitBranch aria-hidden="true" />,
      label: "GitHub",
      description: labels.githubDescription,
    },
    {
      id: "gitlab" as const,
      icon: <GitBranch aria-hidden="true" />,
      label: "GitLab",
      description: labels.gitlabDescription,
    },
    ...(allowDingTalkAITable && host?.parseDingTalkAITableLink
      ? [
          {
            id: "dingtalk_aitable" as const,
            icon: <Grid3X3 aria-hidden="true" />,
            label: labels.aitableProvider,
            description: labels.aitableDescription,
          },
        ]
      : []),
  ];

  return renderModal({
    title: labels.title,
    onClose: () => {
      if (!state.saving) onClose();
    },
    children: (
      <DialogForm
        style={{ display: "contents" }}
        onSubmit={(event) => {
          event.preventDefault();
          void commands.submit();
        }}
      >
        <div className="collaboration-project-create-body">
          <label className="collaboration-project-create-field">
            <span>{labels.name}</span>
            <input
              data-testid={testIds?.name ?? "cloud-project-name"}
              value={state.name}
              onChange={(event) => {
                commands.setName(event.target.value);
                commands.clearError();
              }}
              placeholder={labels.namePlaceholder}
              autoFocus
            />
          </label>

          {targets.length > 1 ? (
            <section>
              <header className="collaboration-project-create-section-header">
                <h3>{labels.location}</h3>
                <small>{labels.locationImmutable}</small>
              </header>
              <div
                className={`collaboration-project-create-grid collaboration-project-create-locations columns-${targets.length}`}
              >
                {targets.map((target) => {
                  const isLocal = target.location === "local";
                  return (
                    <ChoiceButton
                      key={target.location}
                      testId={`cloud-project-location-${target.location}`}
                      selected={state.location === target.location}
                      icon={
                        isLocal ? (
                          <HardDrive aria-hidden="true" />
                        ) : (
                          <Cloud aria-hidden="true" />
                        )
                      }
                      label={
                        isLocal ? labels.localLocation : labels.cloudLocation
                      }
                      description={
                        isLocal
                          ? labels.localLocationDescription
                          : cloudLocationDescription
                      }
                      onClick={() => {
                        commands.setLocation(target.location);
                        commands.clearError();
                      }}
                    />
                  );
                })}
              </div>
            </section>
          ) : null}

          {state.location === "cloud" && (
            <section>
              <h3>{labels.visibility}</h3>
              <div
                className={`collaboration-project-create-grid ${
                  state.taskProvider === "local" ? "columns-3" : "columns-2"
                }`}
              >
                <ChoiceButton
                  testId="cloud-project-visibility-private"
                  selected={state.visibility === "private"}
                  icon={<LockKeyhole aria-hidden="true" />}
                  label={labels.privateVisibility}
                  description={labels.privateVisibilityDescription}
                  onClick={() => commands.setVisibility("private")}
                />
                {state.taskProvider === "local" ? (
                  <ChoiceButton
                    testId="cloud-project-visibility-public-restricted"
                    selected={state.visibility === "public_restricted"}
                    icon={<ListTodo aria-hidden="true" />}
                    label={labels.restrictedVisibility}
                    description={labels.restrictedVisibilityDescription}
                    onClick={() => commands.setVisibility("public_restricted")}
                  />
                ) : null}
                <ChoiceButton
                  testId="cloud-project-visibility-public"
                  selected={state.visibility === "public"}
                  icon={<Cloud aria-hidden="true" />}
                  label={labels.publicVisibility}
                  description={labels.publicVisibilityDescription}
                  onClick={() => commands.setVisibility("public")}
                />
              </div>
              {state.visibility !== "private" && (
                <p className="collaboration-project-create-hint">
                  {state.visibility === "public_restricted"
                    ? labels.restrictedVisibilityDescription
                    : labels.publicVisibilityNotice}
                </p>
              )}
            </section>
          )}

          {resourceSetup ? (
            <section className="collaboration-project-create-collaborators">
              <h3>{labels.collaborators}</h3>
              <div className="collaboration-project-create-collaborator-tokens">
                <CollaboratorToken
                  icon={<UserRound aria-hidden="true" />}
                  label={labels.currentUser}
                />
                {selectedMembers.map((member) => (
                  <CollaboratorToken
                    key={`member:${member.user_id}`}
                    icon={<UserRound aria-hidden="true" />}
                    label={member.user_name}
                    removeLabel={`${labels.cancel} ${member.user_name}`}
                    onRemove={() => removeMember(member.user_id)}
                  />
                ))}
                {selectedAgents.map((agent) => (
                  <CollaboratorToken
                    key={`agent:${agent.id}`}
                    icon={<Bot aria-hidden="true" />}
                    label={agent.name}
                    removeLabel={`${labels.cancel} ${agent.name}`}
                    onRemove={() => removeAgent(agent.id)}
                  />
                ))}
              </div>
              <Popover.Root
                open={collaboratorPickerOpen}
                onOpenChange={setCollaboratorPickerOpen}
              >
                <Popover.Trigger asChild>
                  <button
                    type="button"
                    className="collaboration-project-create-collaborator-trigger"
                    data-testid="collaboration-project-create-add-collaborator"
                    aria-expanded={collaboratorPickerOpen}
                  >
                    <Plus aria-hidden="true" />
                    <span>{labels.addCollaborator}</span>
                  </button>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content
                    {...portalTheme}
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    avoidCollisions={false}
                    className={`${portalTheme.className ?? ""} collaboration-project-create-collaborator-menu`}
                    data-testid="collaboration-project-create-collaborator-menu"
                  >
                    {resourceSetup.createDefaultAgent ? (
                      <button
                        type="button"
                        data-testid="collaboration-project-create-default-agent"
                        disabled={defaultAgentCreating}
                        onClick={() => void createDefaultAgent()}
                      >
                        <Bot aria-hidden="true" />
                        <span>
                          <strong>{labels.createDefaultAgent}</strong>
                          <small>{labels.createDefaultAgentDescription}</small>
                        </span>
                      </button>
                    ) : null}
                    {resourceSetup.groups.length > 0 ? (
                      <div>
                        <small>{labels.availableGroups}</small>
                        {resourceSetup.groups.map((group) => (
                          <button
                            type="button"
                            key={group.id}
                            onClick={() => importGroup(group.id)}
                          >
                            <UsersRound aria-hidden="true" />
                            <span>
                              <strong>{group.name}</strong>
                              <small>{labels.importGroupDescription}</small>
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {!resourceSetup.createDefaultAgent &&
                    resourceSetup.groups.length === 0 ? (
                      <p>{labels.noAvailableCollaborators}</p>
                    ) : null}
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
              {collaboratorError ? (
                <p className="collaboration-project-create-error" role="alert">
                  {collaboratorError}
                </p>
              ) : null}
            </section>
          ) : null}

          <section className="collaboration-project-create-advanced">
            <button
              type="button"
              className="collaboration-project-create-advanced-trigger"
              aria-expanded={advancedSettingsOpen}
              data-testid="collaboration-project-create-advanced"
              onClick={() => setAdvancedSettingsOpen((current) => !current)}
            >
              <span>{labels.advancedSettings}</span>
              <ChevronDown aria-hidden="true" />
            </button>
            {advancedSettingsOpen ? (
              <div className="collaboration-project-create-advanced-content">
                <label className="collaboration-project-create-field">
                  <span>
                    {labels.description} <small>{labels.optional}</small>
                  </span>
                  <textarea
                    data-testid={
                      testIds?.description ?? "cloud-project-description"
                    }
                    value={state.description}
                    onChange={(event) =>
                      commands.setDescription(event.target.value)
                    }
                    placeholder={labels.descriptionPlaceholder}
                  />
                </label>
                <section>
                  <h3>{labels.taskProvider}</h3>
                  <div className="collaboration-project-create-grid collaboration-project-create-providers">
                    {providers.map((provider) => (
                      <ChoiceButton
                        key={provider.id}
                        testId={`cloud-project-task-provider-${provider.id}`}
                        selected={state.taskProvider === provider.id}
                        icon={provider.icon}
                        label={provider.label}
                        description={provider.description}
                        onClick={() => {
                          commands.setTaskProvider(provider.id);
                          commands.clearError();
                        }}
                      />
                    ))}
                  </div>
                </section>

                {state.repositoryProvider ? (
                  <section className="collaboration-project-create-provider-config">
                    <label className="collaboration-project-create-field">
                      <span>{labels.repository}</span>
                      <input
                        data-testid="cloud-project-provider-repository"
                        value={state.repositoryAddress}
                        onChange={(event) => {
                          commands.setRepositoryAddress(event.target.value);
                          commands.clearError();
                        }}
                        placeholder={
                          state.taskProvider === "github"
                            ? "https://github.com/owner/repository"
                            : "https://gitlab.com/group/project"
                        }
                      />
                      <small>{labels.repositoryHint}</small>
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
                          onChange={(event) =>
                            commands.setToken(event.target.value)
                          }
                          placeholder={labels.privateRepositoryToken}
                        />
                      </div>
                      <small>
                        {state.location === "cloud"
                          ? labels.cloudTokenHint
                          : labels.localTokenHint}
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
                        onChange={(event) => {
                          commands.setAitableUrl(event.target.value);
                          commands.clearError();
                        }}
                        placeholder={labels.aitablePlaceholder}
                      />
                      <small
                        className={
                          state.aitableUrl && !state.aitableLink
                            ? "is-error"
                            : ""
                        }
                      >
                        {state.aitableUrl && !state.aitableLink
                          ? labels.aitableInvalid
                          : labels.aitableHint}
                      </small>
                    </label>
                    <p className="collaboration-project-create-hint">
                      {labels.aitableRuntimeHint}
                    </p>
                  </section>
                ) : null}
              </div>
            ) : null}
          </section>

          {state.error && (
            <p className="collaboration-project-create-error" role="alert">
              {state.error}
            </p>
          )}
        </div>
        <footer className="collaboration-project-create-footer">
          <button
            type="button"
            disabled={state.saving}
            onClick={() => {
              if (!state.saving) onClose();
            }}
          >
            {labels.cancel}
          </button>
          <button
            type="submit"
            className="collaboration-primary-button"
            data-testid={testIds?.confirm ?? "cloud-project-create-confirm"}
            disabled={!state.canSubmit}
          >
            {state.saving ? labels.creating : labels.create}
          </button>
        </footer>
      </DialogForm>
    ),
  });
}
