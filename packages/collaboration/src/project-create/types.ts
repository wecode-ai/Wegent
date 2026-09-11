// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

import type { WorkspaceProjectCreateInput } from "../ports/SharedWorkspaceApi";
import type { CollaborationProject } from "../types";

export type ProjectCreateLocation = "local" | "cloud";
export type ProjectCreateProvider = NonNullable<
  WorkspaceProjectCreateInput["taskProvider"]
>;

export interface ProjectCreateTarget {
  location: ProjectCreateLocation;
  create(input: WorkspaceProjectCreateInput): Promise<CollaborationProject>;
}

export interface DingTalkAITableLink {
  baseId: string;
  tableId: string;
  viewId?: string;
  url: string;
}

export interface ProjectCreateModalProps {
  title: string;
  children: ReactNode;
  onClose(): void;
}

export interface ProjectCreateHostAdapter {
  renderModal?(props: ProjectCreateModalProps): ReactNode;
  parseDingTalkAITableLink?(value: string): DingTalkAITableLink | null;
  formatError?(cause: unknown): string;
  track?(event: "created" | "failed"): void;
}

export interface ProjectCreateLabels {
  title: string;
  name: string;
  namePlaceholder: string;
  location: string;
  locationImmutable: string;
  localLocation: string;
  localLocationDescription: string;
  cloudLocation: string;
  cloudLocationDescription: string;
  visibility: string;
  privateVisibility: string;
  privateVisibilityDescription: string;
  publicVisibility: string;
  publicVisibilityDescription: string;
  publicVisibilityNotice: string;
  taskProvider: string;
  builtInProvider: string;
  builtInLocalDescription: string;
  builtInCloudDescription: string;
  githubDescription: string;
  gitlabDescription: string;
  aitableProvider: string;
  aitableDescription: string;
  repository: string;
  repositoryHint: string;
  token: string;
  optional: string;
  privateRepositoryToken: string;
  cloudTokenHint: string;
  localTokenHint: string;
  aitableUrl: string;
  aitablePlaceholder: string;
  aitableInvalid: string;
  aitableHint: string;
  aitableRuntimeHint: string;
  description: string;
  descriptionPlaceholder: string;
  cancel: string;
  create: string;
  creating: string;
  unavailableLocation: string;
  repositoryRequired: string;
  repositoryInvalid: string;
  githubRepositoryInvalid: string;
  gitlabRepositoryInvalid: string;
  createFailed: string;
}

export interface ProjectCreateDialogProps {
  targets: ProjectCreateTarget[];
  defaultLocation: ProjectCreateLocation;
  allowDingTalkAITable: boolean;
  labels: ProjectCreateLabels;
  testIds?: {
    name?: string;
    description?: string;
    confirm?: string;
  };
  host?: ProjectCreateHostAdapter;
  onClose(): void;
  onCreated(
    project: CollaborationProject,
    location: ProjectCreateLocation,
  ): void;
}
