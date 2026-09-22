// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  SharedWorkspaceApi,
  WorkspaceAutomationRule,
} from "../ports/SharedWorkspaceApi";

type AutomationsApi = NonNullable<SharedWorkspaceApi["automations"]>;

// Keep snapshots within the API session and project; reopening still revalidates them.
const snapshots = new WeakMap<
  AutomationsApi,
  Map<string, WorkspaceAutomationRule[]>
>();

export function useAutomaticProcessingRules(
  api: SharedWorkspaceApi["automations"],
  projectId: string,
) {
  const cached = api ? snapshots.get(api)?.get(projectId) : undefined;
  const [state, setState] = useState({
    api,
    projectId,
    rules: cached ?? [],
    loading: Boolean(api) && cached === undefined,
    error: null as unknown,
  });
  const requestId = useRef(0);
  const activeScope = useRef<{ api: typeof api; projectId: string } | null>(
    null,
  );
  const load = useCallback(async () => {
    if (
      activeScope.current?.api !== api ||
      activeScope.current?.projectId !== projectId
    )
      return;
    const id = ++requestId.current;
    if (!api) return;
    const previous = snapshots.get(api)?.get(projectId);
    setState({
      api,
      projectId,
      rules: previous ?? [],
      loading: previous === undefined,
      error: null,
    });
    try {
      const rules = await api.list(projectId);
      if (id !== requestId.current) return;
      let projects = snapshots.get(api);
      if (!projects) {
        projects = new Map();
        snapshots.set(api, projects);
      }
      projects.set(projectId, rules);
      setState({ api, projectId, rules, loading: false, error: null });
    } catch (error) {
      if (id !== requestId.current) return;
      setState({
        api,
        projectId,
        rules: previous ?? [],
        loading: false,
        error,
      });
    }
  }, [api, projectId]);

  useEffect(() => {
    activeScope.current = { api, projectId };
    void load();
    return () => {
      activeScope.current = null;
      requestId.current++;
    };
  }, [api, projectId, load]);

  const current =
    state.api === api && state.projectId === projectId
      ? state
      : {
          rules: cached ?? [],
          loading: Boolean(api) && cached === undefined,
          error: null,
        };
  return { ...current, load };
}
