// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, type ReactNode } from "react";

import { canAccessCollaborationProjectView } from "../permissions";
import type { CollaborationProject } from "../types";
import {
  ProjectViewSwitcher,
  type CollaborationProjectView,
  type CollaborationProjectViewOption,
} from "../workspace-header/ProjectViewSwitcher";
import { ProjectShell, type ProjectShellProps } from "./ProjectShell";

export const collaborationProjectViewIds = [
  "board",
  "table",
  "manage",
] as const;

export type StandardCollaborationProjectView =
  (typeof collaborationProjectViewIds)[number];

export interface CollaborationProjectViewLabels {
  board: string;
  table: string;
  files: string;
  automation: string;
  manage: string;
}

export interface CollaborationProjectViewTestIds {
  board: string;
  table: string;
  files: string;
  automation: string;
  manage: string;
}

export interface CollaborationProjectViewExtension {
  id: CollaborationProjectView;
  label: string;
  testId: string;
  content: ReactNode;
  available?: boolean;
}

export interface CollaborationProjectViewSlots {
  board: ReactNode;
  table: ReactNode;
  files: ReactNode;
  automation: ReactNode;
  manage: ReactNode;
}

export interface ResolvedCollaborationProjectView {
  content: ReactNode;
  view: CollaborationProjectView;
  viewChanged: boolean;
}

export function resolveCollaborationProjectView({
  extensions,
  options,
  slots,
  view,
}: {
  extensions: CollaborationProjectViewExtension[];
  options: CollaborationProjectViewOption[];
  slots: CollaborationProjectViewSlots;
  view: CollaborationProjectView;
}): ResolvedCollaborationProjectView {
  const requestedView =
    view === "automation" || view === "files" ? "manage" : view;
  const accessibleView = options.some((option) => option.id === requestedView)
    ? requestedView
    : "board";
  const extensionContent = extensions.find(
    (extension) => extension.id === accessibleView,
  )?.content;
  const content =
    extensionContent ??
    (collaborationProjectViewIds.includes(
      accessibleView as StandardCollaborationProjectView,
    )
      ? slots[accessibleView as StandardCollaborationProjectView]
      : null);

  return {
    content,
    view: accessibleView,
    viewChanged: accessibleView !== view,
  };
}

export function synchronizeCollaborationProjectView(
  resolved: ResolvedCollaborationProjectView,
  onViewChange: (view: CollaborationProjectView) => void,
): void {
  if (resolved.viewChanged) onViewChange(resolved.view);
}

export function buildCollaborationProjectViewOptions({
  project,
  labels,
  testIds,
  automationSupported,
  enabledStandardViews = collaborationProjectViewIds,
  extensions = [],
}: {
  project: Pick<CollaborationProject, "access_role" | "project_store">;
  labels: CollaborationProjectViewLabels;
  testIds: CollaborationProjectViewTestIds;
  automationSupported: boolean;
  enabledStandardViews?: readonly StandardCollaborationProjectView[];
  extensions?: CollaborationProjectViewExtension[];
}): CollaborationProjectViewOption[] {
  const enabledStandardViewIds = new Set(enabledStandardViews);
  const standardOptions = collaborationProjectViewIds
    .filter(
      (view) =>
        enabledStandardViewIds.has(view) &&
        canAccessCollaborationProjectView(project, view, automationSupported),
    )
    .map((view) => ({
      id: view,
      label: labels[view],
      testId: testIds[view],
    }));
  const standardIds = new Set<CollaborationProjectView>(
    standardOptions.map((option) => option.id),
  );
  const extensionOptions = extensions
    .filter(
      (extension) =>
        extension.available !== false && !standardIds.has(extension.id),
    )
    .map(({ id, label, testId }) => ({ id, label, testId }));

  return [
    standardOptions[0],
    ...extensionOptions,
    ...standardOptions.slice(1),
  ].filter((option): option is CollaborationProjectViewOption =>
    Boolean(option),
  );
}

export interface CollaborationProjectViewShellProps extends Omit<
  ProjectShellProps,
  "boardView" | "children" | "renderViewSwitcher"
> {
  project: Pick<CollaborationProject, "access_role" | "project_store">;
  view: CollaborationProjectView;
  labels: CollaborationProjectViewLabels;
  testIds: CollaborationProjectViewTestIds;
  slots: CollaborationProjectViewSlots;
  automationSupported?: boolean;
  enabledStandardViews?: readonly StandardCollaborationProjectView[];
  extensions?: CollaborationProjectViewExtension[];
  switcherAriaLabel?: string;
  compactSwitcherIcon?: ReactNode;
  onViewChange(view: CollaborationProjectView): void;
}

export function CollaborationProjectViewShell({
  project,
  view,
  labels,
  testIds,
  slots,
  automationSupported = true,
  enabledStandardViews,
  extensions = [],
  switcherAriaLabel,
  compactSwitcherIcon,
  onViewChange,
  ...shellProps
}: CollaborationProjectViewShellProps) {
  const options = buildCollaborationProjectViewOptions({
    project,
    labels,
    testIds,
    automationSupported,
    enabledStandardViews,
    extensions,
  });
  const resolved = resolveCollaborationProjectView({
    extensions,
    options,
    slots,
    view,
  });

  useEffect(() => {
    synchronizeCollaborationProjectView(resolved, onViewChange);
  }, [onViewChange, resolved.view, resolved.viewChanged]);

  return (
    <ProjectShell
      {...shellProps}
      boardView={resolved.view === "board"}
      renderViewSwitcher={({ compact, containerRef }) =>
        options.length > 1 ? (
          <ProjectViewSwitcher
            ariaLabel={switcherAriaLabel}
            compact={compact}
            compactIcon={compactSwitcherIcon}
            containerRef={containerRef}
            value={resolved.view}
            options={options}
            onChange={onViewChange}
          />
        ) : null
      }
    >
      {resolved.content}
    </ProjectShell>
  );
}
