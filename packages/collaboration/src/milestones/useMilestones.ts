import type { CollaborationProject } from "../types";
import { getClientRequestCache } from "@wegent/chat-core/request-cache";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Milestone, MilestonesApi } from "./types";

interface QueryState {
  projectId: string;
  authScope: unknown;
  visibilityScope: string;
  api: MilestonesApi;
  items: Milestone[];
  loading: boolean;
  error: boolean;
}

function matchesScope(
  state: QueryState | null,
  api: MilestonesApi | undefined,
  projectId: string,
  authScope: unknown,
  visibilityScope: string,
): state is QueryState {
  return (
    state?.projectId === projectId &&
    state.api === api &&
    state.authScope === authScope &&
    state.visibilityScope === visibilityScope
  );
}

export function useMilestones(
  api: MilestonesApi | undefined,
  projectId: string,
  enabled = true,
  refreshKey?: string,
  visibilityScope = "",
) {
  const authScope = api?.getCacheScope?.();
  const cacheKey = `milestones:${projectId}:${visibilityScope}`;
  const [state, setState] = useState<QueryState | null>(null);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const previousRefreshKey = useRef(refreshKey);
  const reload = useCallback(() => {
    if (api) getClientRequestCache(api).invalidate(cacheKey);
    setRevision((value) => value + 1);
  }, [api, cacheKey]);
  useEffect(() => {
    if (!api || !projectId || !enabled) return;
    if (previousRefreshKey.current !== refreshKey) {
      getClientRequestCache(api).invalidate(cacheKey);
      previousRefreshKey.current = refreshKey;
    }
    const request = ++generation.current;
    const initial = {
      projectId,
      api,
      authScope,
      visibilityScope,
      items: [],
      loading: true,
      error: false,
    };
    setState((previous) =>
      matchesScope(previous, api, projectId, authScope, visibilityScope)
        ? { ...previous, loading: true, error: false }
        : initial,
    );
    void getClientRequestCache(api)
      .get(cacheKey, () => api.list(projectId), 0)
      .then((items) => {
        if (request === generation.current)
          setState({ ...initial, items, loading: false });
      })
      .catch(() => {
        if (request === generation.current)
          setState((previous) => ({
            ...(matchesScope(
              previous,
              api,
              projectId,
              authScope,
              visibilityScope,
            )
              ? previous
              : initial),
            loading: false,
            error: true,
          }));
      });
    return () => {
      generation.current++;
    };
  }, [
    api,
    projectId,
    enabled,
    revision,
    refreshKey,
    authScope,
    visibilityScope,
    cacheKey,
  ]);
  const current = matchesScope(
    state,
    api,
    projectId,
    authScope,
    visibilityScope,
  )
    ? state
    : null;
  return {
    items: current?.items ?? [],
    loading: Boolean(
      enabled && api && projectId && (!current || current.loading),
    ),
    error: current?.error ?? false,
    reload,
  };
}

export function milestoneVisibilityScope(
  project: Pick<
    CollaborationProject,
    | "current_user_id"
    | "access_role"
    | "project_store"
    | "default_issue_security"
  >,
): string {
  return JSON.stringify([
    project.current_user_id,
    project.access_role,
    project.project_store,
    project.default_issue_security,
  ]);
}
