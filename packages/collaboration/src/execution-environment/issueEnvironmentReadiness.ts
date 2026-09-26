// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationExecutionEnvironment,
  CollaborationProject,
} from "../types";

export type ProjectExecutionEnvironmentReadinessKind =
  | "not_applicable"
  | "loading"
  | "ready"
  | "unassigned"
  | "offline"
  | "uninitialized"
  | "preparing"
  | "error"
  | "unknown";

export interface ProjectExecutionEnvironmentReadiness {
  kind: ProjectExecutionEnvironmentReadinessKind;
  environments: CollaborationExecutionEnvironment[];
}

const EMPTY_ENVIRONMENTS: CollaborationExecutionEnvironment[] = [];

function environmentDeviceKey(
  environment: CollaborationExecutionEnvironment,
): string {
  return environment.device_key?.trim() ?? String(environment.device_id ?? "");
}

export function resolveProjectExecutionEnvironmentReadiness(
  project: Pick<
    CollaborationProject,
    "project_store" | "execution_environment"
  >,
  environments: CollaborationExecutionEnvironment[],
): ProjectExecutionEnvironmentReadiness {
  if (environments.length === 0) {
    return { kind: "unassigned", environments };
  }

  const deviceStates = project.execution_environment?.devices ?? {};
  const stateFor = (environment: CollaborationExecutionEnvironment) =>
    deviceStates[environmentDeviceKey(environment)];
  const hasRunnableEnvironment = environments.some((environment) => {
    const deviceState = stateFor(environment);
    return (
      environment.status === "online" &&
      deviceState?.status === "ready" &&
      Boolean(deviceState.workspace_path?.trim())
    );
  });
  if (hasRunnableEnvironment) return { kind: "ready", environments };

  if (
    environments.some(
      (environment) =>
        environment.status === "provisioning" ||
        stateFor(environment)?.status === "preparing",
    )
  ) {
    return { kind: "preparing", environments };
  }
  if (
    environments.some(
      (environment) =>
        environment.status === "error" ||
        stateFor(environment)?.status === "error",
    )
  ) {
    return { kind: "error", environments };
  }

  const hasPreparedOfflineEnvironment = environments.some((environment) => {
    const deviceState = stateFor(environment);
    return (
      environment.status !== "online" &&
      deviceState?.status === "ready" &&
      Boolean(deviceState.workspace_path?.trim())
    );
  });
  if (
    hasPreparedOfflineEnvironment ||
    environments.every((environment) => environment.status !== "online")
  ) {
    return { kind: "offline", environments };
  }
  return { kind: "uninitialized", environments };
}

export function useProjectExecutionEnvironmentReadiness({
  api,
  project,
  refreshIntervalMs = 15_000,
}: {
  api: SharedWorkspaceApi;
  project: CollaborationProject | null | undefined;
  refreshIntervalMs?: number;
}): ProjectExecutionEnvironmentReadiness & {
  refresh(): Promise<ProjectExecutionEnvironmentReadiness>;
} {
  const requestRevision = useRef(0);
  const readinessProjectId = useRef(project?.id ?? null);
  const [readiness, setReadiness] =
    useState<ProjectExecutionEnvironmentReadiness>(() =>
      !project
        ? { kind: "not_applicable", environments: EMPTY_ENVIRONMENTS }
        : { kind: "loading", environments: EMPTY_ENVIRONMENTS },
    );

  const refresh = useCallback(async () => {
    if (!project) {
      requestRevision.current += 1;
      const nextReadiness: ProjectExecutionEnvironmentReadiness = {
        kind: "not_applicable",
        environments: EMPTY_ENVIRONMENTS,
      };
      setReadiness(nextReadiness);
      return nextReadiness;
    }
    const revision = ++requestRevision.current;
    try {
      const environments = await api.projects.listExecutionEnvironments(
        project.id,
      );
      const nextReadiness = resolveProjectExecutionEnvironmentReadiness(
        project,
        environments,
      );
      if (revision === requestRevision.current) {
        setReadiness(nextReadiness);
      }
      return nextReadiness;
    } catch {
      const nextReadiness: ProjectExecutionEnvironmentReadiness = {
        kind: "unknown",
        environments: EMPTY_ENVIRONMENTS,
      };
      if (revision === requestRevision.current) {
        setReadiness(nextReadiness);
      }
      return nextReadiness;
    }
  }, [api, project]);

  useEffect(() => {
    if (!project) {
      readinessProjectId.current = null;
      void refresh();
      return;
    }
    const sameProject = readinessProjectId.current === project.id;
    readinessProjectId.current = project.id;
    setReadiness((current) =>
      sameProject && current.environments.length > 0
        ? resolveProjectExecutionEnvironmentReadiness(
            project,
            current.environments,
          )
        : { kind: "loading", environments: EMPTY_ENVIRONMENTS },
    );
    void refresh();
    const refreshWhenVisible = () => {
      if (
        typeof document === "undefined" ||
        document.visibilityState !== "hidden"
      ) {
        void refresh();
      }
    };
    const interval =
      refreshIntervalMs > 0
        ? window.setInterval(refreshWhenVisible, refreshIntervalMs)
        : null;
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      requestRevision.current += 1;
      if (interval != null) window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [project?.id, project?.version, refresh, refreshIntervalMs]);

  return { ...readiness, refresh };
}
