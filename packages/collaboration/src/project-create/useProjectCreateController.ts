// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";

import type { CollaborationExecutionEnvironment } from "../types";

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

type ProjectVisibility = NonNullable<
  import("../ports/SharedWorkspaceApi").WorkspaceProjectCreateInput["visibility"]
>;

export function defaultExecutionEnvironmentDeviceIds(
  environments: CollaborationExecutionEnvironment[],
): number[] {
  const deviceIds = new Map<string, number>();
  for (const environment of environments) {
    const deviceId = environment.device_id;
    if (
      !environment.is_current_device ||
      environment.kind !== "local_device" ||
      environment.status !== "online" ||
      deviceId == null ||
      !Number.isSafeInteger(deviceId) ||
      deviceId <= 0
    ) {
      continue;
    }
    const identity = environment.device_key?.trim() || String(deviceId);
    if (!deviceIds.has(identity)) deviceIds.set(identity, deviceId);
  }
  return [...deviceIds.values()];
}

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
  resourceSetup,
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
  const [visibility, setVisibility] = useState<ProjectVisibility>("private");
  const [repositoryAddress, setRepositoryAddress] = useState("");
  const [token, setToken] = useState("");
  const [aitableUrl, setAitableUrl] = useState("");
  const [memberUserIds, setMemberUserIds] = useState<number[]>([]);
  const [agentResourceIds, setAgentResourceIds] = useState<string[]>([]);
  const [executionEnvironmentDeviceIds, setExecutionEnvironmentDeviceIds] =
    useState<number[]>(() =>
      defaultExecutionEnvironmentDeviceIds(
        resourceSetup?.executionEnvironments ?? [],
      ),
    );
  const executionEnvironmentSelectionChanged = useRef(false);
  const [leaderId, setLeaderId] = useState("");
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

  useEffect(() => {
    if (executionEnvironmentSelectionChanged.current) return;
    setExecutionEnvironmentDeviceIds(
      defaultExecutionEnvironmentDeviceIds(
        resourceSetup?.executionEnvironments ?? [],
      ),
    );
  }, [resourceSetup?.executionEnvironments]);

  useEffect(() => {
    if (taskProvider !== "local" && visibility === "public_restricted") {
      setVisibility("private");
    }
  }, [taskProvider, visibility]);

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
      if (resourceSetup) {
        await resourceSetup.configure(project, {
          memberUserIds,
          agentResourceIds,
          executionEnvironmentDeviceIds,
          leaderId,
        });
      }
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
      memberUserIds,
      agentResourceIds,
      executionEnvironmentDeviceIds,
      leaderId,
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
      setMemberUserIds,
      setAgentResourceIds,
      setExecutionEnvironmentDeviceIds: (deviceIds: number[]) => {
        executionEnvironmentSelectionChanged.current = true;
        setExecutionEnvironmentDeviceIds(deviceIds);
      },
      setLeaderId,
      clearError: () => setError(null),
      submit,
    },
  };
}
