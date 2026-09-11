// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";

import {
  RepositoryProviderError,
  repositoryProviderConfig,
} from "./projectProviderConfig";
import type {
  DingTalkAITableLink,
  ProjectCreateDialogProps,
  ProjectCreateLocation,
  ProjectCreateProvider,
  ProjectCreateHostAdapter,
  ProjectCreateLabels,
} from "./types";

export function projectCreateErrorMessage(
  cause: unknown,
  labels: ProjectCreateLabels,
  host?: ProjectCreateHostAdapter,
): string {
  if (cause instanceof RepositoryProviderError) {
    return {
      repository_required: labels.repositoryRequired,
      repository_invalid: labels.repositoryInvalid,
      github_repository_invalid: labels.githubRepositoryInvalid,
      gitlab_repository_invalid: labels.gitlabRepositoryInvalid,
    }[cause.code];
  }
  return (
    host?.formatError?.(cause) ??
    (cause instanceof Error && cause.message
      ? cause.message
      : labels.createFailed)
  );
}

export function useProjectCreateController({
  targets,
  defaultLocation,
  host,
  labels,
  onCreated,
}: ProjectCreateDialogProps) {
  const initialLocation =
    targets.find((target) => target.location === defaultLocation)?.location ??
    targets[0]?.location ??
    "cloud";
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] =
    useState<ProjectCreateLocation>(initialLocation);
  const [taskProvider, setTaskProvider] =
    useState<ProjectCreateProvider>("local");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [repositoryAddress, setRepositoryAddress] = useState("");
  const [token, setToken] = useState("");
  const [aitableUrl, setAitableUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const repositoryProvider =
    taskProvider === "github" || taskProvider === "gitlab";
  const isAITableProvider = taskProvider === "dingtalk_aitable";
  const aitableLink = useMemo<DingTalkAITableLink | null>(
    () =>
      isAITableProvider && host?.parseDingTalkAITableLink
        ? host.parseDingTalkAITableLink(aitableUrl)
        : null,
    [aitableUrl, host, isAITableProvider],
  );
  const canSubmit = Boolean(
    name.trim() &&
    (!repositoryProvider || repositoryAddress.trim()) &&
    (!isAITableProvider || aitableLink) &&
    !saving,
  );

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const target = targets.find(
        (candidate) => candidate.location === location,
      );
      if (!target) throw new Error(labels.unavailableLocation);
      const providerConfig = isAITableProvider
        ? {
            base_id: aitableLink!.baseId,
            table_id: aitableLink!.tableId,
            source_url: aitableLink!.url,
            ...(aitableLink!.viewId ? { view_id: aitableLink!.viewId } : {}),
          }
        : repositoryProvider
          ? {
              ...repositoryProviderConfig(repositoryAddress, taskProvider),
              ...(token.trim() ? { token: token.trim() } : {}),
            }
          : {};
      const project = await target.create({
        name: name.trim(),
        description: description.trim(),
        taskProvider,
        providerConfig,
        ...(location === "cloud" ? { visibility } : {}),
      });
      host?.track?.("created");
      onCreated(project, location);
    } catch (cause) {
      host?.track?.("failed");
      setError(projectCreateErrorMessage(cause, labels, host));
    } finally {
      setSaving(false);
    }
  }

  return {
    state: {
      name,
      description,
      location,
      taskProvider,
      visibility,
      repositoryAddress,
      token,
      aitableUrl,
      aitableLink,
      repositoryProvider,
      isAITableProvider,
      saving,
      error,
      canSubmit,
    },
    commands: {
      setName,
      setDescription,
      setLocation,
      setTaskProvider,
      setVisibility,
      setRepositoryAddress,
      setToken,
      setAitableUrl,
      clearError: () => setError(null),
      submit,
    },
  };
}
