// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  Cloud,
  GitBranch,
  Grid3X3,
  HardDrive,
  ListTodo,
  LockKeyhole,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

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

export function ProjectCreateDialog(props: ProjectCreateDialogProps) {
  const { targets, allowDingTalkAITable, labels, testIds, host, onClose } =
    props;
  const { state, commands } = useProjectCreateController(props);
  const renderModal =
    host?.renderModal ?? ((modalProps) => <DefaultModal {...modalProps} />);
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
    onClose,
    children: (
      <>
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
                        : labels.cloudLocationDescription
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

          {state.location === "cloud" && (
            <section>
              <h3>{labels.visibility}</h3>
              <div className="collaboration-project-create-grid columns-2">
                <ChoiceButton
                  testId="cloud-project-visibility-private"
                  selected={state.visibility === "private"}
                  icon={<LockKeyhole aria-hidden="true" />}
                  label={labels.privateVisibility}
                  description={labels.privateVisibilityDescription}
                  onClick={() => commands.setVisibility("private")}
                />
                <ChoiceButton
                  testId="cloud-project-visibility-public"
                  selected={state.visibility === "public"}
                  icon={<Cloud aria-hidden="true" />}
                  label={labels.publicVisibility}
                  description={labels.publicVisibilityDescription}
                  onClick={() => commands.setVisibility("public")}
                />
              </div>
              {state.visibility === "public" && (
                <p className="collaboration-project-create-hint">
                  {labels.publicVisibilityNotice}
                </p>
              )}
            </section>
          )}

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

          {state.repositoryProvider && (
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
                    onChange={(event) => commands.setToken(event.target.value)}
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
          )}

          {state.isAITableProvider && (
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
                    state.aitableUrl && !state.aitableLink ? "is-error" : ""
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
          )}

          <label className="collaboration-project-create-field">
            <span>
              {labels.description} <small>{labels.optional}</small>
            </span>
            <textarea
              data-testid={testIds?.description ?? "cloud-project-description"}
              value={state.description}
              onChange={(event) => commands.setDescription(event.target.value)}
              placeholder={labels.descriptionPlaceholder}
            />
          </label>

          {state.error && (
            <p className="collaboration-project-create-error" role="alert">
              {state.error}
            </p>
          )}
        </div>
        <footer className="collaboration-project-create-footer">
          <button type="button" onClick={onClose}>
            {labels.cancel}
          </button>
          <button
            type="button"
            className="collaboration-primary-button"
            data-testid={testIds?.confirm ?? "cloud-project-create-confirm"}
            disabled={!state.canSubmit}
            onClick={() => void commands.submit()}
          >
            {state.saving ? labels.creating : labels.create}
          </button>
        </footer>
      </>
    ),
  });
}
