// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo, type ComponentType, type SVGProps } from "react";

import {
  createSharedWorkspaceProjectManageApi,
  ProjectManageView,
  type ProjectManageHost,
} from "./project-manage";
import { ProjectAgentConfiguration } from "./project-agent-config";
import type { SharedWorkspaceApi } from "./ports/SharedWorkspaceApi";
import type { CollaborationProject } from "./types";
import type { CollaborationTranslate } from "./i18n";

interface CollaborationSettingsProps {
  api: SharedWorkspaceApi;
  project: CollaborationProject;
  onChange(project: CollaborationProject): void;
  onError(): void;
  translate: CollaborationTranslate;
}

function createManageIcon(
  paths: string[],
): ComponentType<SVGProps<SVGSVGElement>> {
  return function ManageIcon({ className }) {
    return (
      <svg
        aria-hidden="true"
        className={className}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth="2"
      >
        {paths.map((path) => (
          <path d={path} key={path} />
        ))}
      </svg>
    );
  };
}

const manageIcons: ProjectManageHost["icons"] = {
  Check: createManageIcon(["M5 12l4 4L19 7"]),
  GitBranch: createManageIcon(["M6 3v12", "M18 9V3", "M6 9h8a4 4 0 0 0 4-4"]),
  LockKeyhole: createManageIcon([
    "M7 10V7a5 5 0 0 1 10 0v3",
    "M5 10h14v11H5z",
    "M12 14v3",
  ]),
  Pencil: createManageIcon(["M4 20l4-1 11-11-3-3L5 16z", "M14 7l3 3"]),
  Search: createManageIcon([
    "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14",
    "M16 16l5 5",
  ]),
  Trash2: createManageIcon(["M4 7h16", "M9 7V4h6v3", "M7 7l1 14h8l1-14"]),
  X: createManageIcon(["M6 6l12 12", "M18 6L6 18"]),
};

export function CollaborationSettings({
  api,
  project,
  onChange,
  onError,
  translate,
}: CollaborationSettingsProps) {
  const manageApi = useMemo(
    () => createSharedWorkspaceProjectManageApi(api),
    [api],
  );

  const host = useMemo<ProjectManageHost>(
    () => ({
      icons: manageIcons,
      translate,
      confirm: (message) => window.confirm(message),
      trackCompleted: () => undefined,
      trackFailed: onError,
      renderTooltip: ({ label, children }) => (
        <span title={label}>{children}</span>
      ),
      renderActionMenu: ({ ariaLabel, testId, triggerClassName, items }) => (
        <details className="relative">
          <summary
            aria-label={ariaLabel}
            className={triggerClassName}
            data-testid={testId}
          >
            ···
          </summary>
          <div className="absolute right-0 z-10 min-w-28 rounded-lg border border-border bg-background p-1 shadow-lg">
            {items.map((item) => {
              const Icon = item.icon as ComponentType<{ className?: string }>;
              return (
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                  data-testid={item.testId}
                  disabled={item.disabled}
                  key={item.testId}
                  onClick={() => void item.onSelect()}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                </button>
              );
            })}
          </div>
        </details>
      ),
    }),
    [onError, translate],
  );

  return (
    <ProjectManageView
      api={manageApi}
      host={host}
      project={project}
      onProjectUpdated={onChange}
      renderProviderSettings={() => (
        <ProjectAgentConfiguration
          api={api}
          project={project}
          onError={onError}
          translate={translate}
        />
      )}
    />
  );
}
