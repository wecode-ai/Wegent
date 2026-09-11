import { useCallback, useEffect, useRef, useState } from "react";
import {
  automationInputFromUi,
  automationRuleFromBackend,
  automationRuleFromLegacyWorkflow,
  automationRunFromBackend,
  legacyWorkflowFromAutomationRule,
  type AutomationUiRule,
  type AutomationUiRun,
} from "./model";
import type {
  AutomationBackendInput,
  AutomationBackendRule,
  AutomationBackendRun,
  AutomationEventSourceCatalogItem,
  AutomationProject,
  ProjectWorkflowDefinition,
} from "./types";

export interface AutomationCloudApi {
  list(projectId: string): Promise<AutomationBackendRule[]>;
  create(
    projectId: string,
    input: AutomationBackendInput,
  ): Promise<AutomationBackendRule>;
  migrateWorkflow(
    projectId: string,
    input: {
      projectVersion: number;
      automation: AutomationBackendInput;
      workflowDefinition: ProjectWorkflowDefinition;
    },
  ): Promise<{
    automation: AutomationBackendRule;
    projectVersion: number;
    workflowAutomationId: string;
  }>;
  update(
    projectId: string,
    automationId: string,
    input: Partial<AutomationBackendInput> & { version: number },
  ): Promise<AutomationBackendRule>;
  remove(
    projectId: string,
    automationId: string,
  ): Promise<{ projectVersion: number; workflowAutomationId: string | null }>;
  runNow(
    projectId: string,
    automationId: string,
  ): Promise<AutomationBackendRun>;
  listRuns(
    projectId: string,
    automationId: string,
  ): Promise<AutomationBackendRun[]>;
}

export interface AutomationProjectApi<P extends AutomationProject> {
  clearLegacyWorkflow(
    project: P,
    workflowDefinition: ProjectWorkflowDefinition,
  ): Promise<P>;
}

export interface AutomationIncomingHooksApi {
  catalog(): Promise<AutomationEventSourceCatalogItem[]>;
}

export interface UseAutomationCloudStateOptions<P extends AutomationProject> {
  api?: AutomationCloudApi;
  cacheSource?: object;
  projectApi: AutomationProjectApi<P>;
  incomingHooksApi?: AutomationIncomingHooksApi;
  project: P;
  currentUserId?: string | number;
  canManage: boolean;
  legacyUpgradeRequiredMessage: string;
  serviceUnavailableMessage: string;
  managePermissionMessage: string;
  runtimeUserRequiredMessage: string;
  duplicateName: (name: string) => string;
  onProjectUpdated?: (project: P) => void;
  onRunRefreshError?: (error: unknown) => void;
}

interface AutomationRunSource {
  automationId: string;
  ruleId: string;
}

interface AutomationRuleSnapshot {
  rules: AutomationUiRule[];
  runSources: AutomationRunSource[];
  updatedProject?: AutomationProject;
}

interface AutomationRuleCacheEntry extends AutomationRuleSnapshot {
  source: object;
  updatedAt: number;
}

interface AutomationRuleLoadRequest {
  source: object;
  api: AutomationCloudApi;
  promise: Promise<AutomationRuleSnapshot>;
}

interface AutomationScopeToken {
  cacheKey: string;
  api: AutomationCloudApi | undefined;
  cacheSource: object | undefined;
}

interface AutomationRunsRequest {
  scope: AutomationScopeToken;
  promise: Promise<AutomationUiRun[]>;
}

const AUTOMATION_CACHE_FRESH_MS = 30_000;
const AUTOMATION_RUN_REFRESH_MS = 15_000;
const ruleCache = new Map<string, AutomationRuleCacheEntry>();
const ruleLoads = new Map<string, AutomationRuleLoadRequest>();

function readRuleCache(cacheKey: string, source: object | undefined) {
  if (!source) return null;
  const cached = ruleCache.get(cacheKey);
  return cached?.source === source ? cached : null;
}

function buildRuleSnapshot(
  project: AutomationProject,
  backendRules: AutomationBackendRule[],
): AutomationRuleSnapshot {
  const canonicalRule = project.workflow_automation_id
    ? backendRules.find((rule) => rule.id === project.workflow_automation_id)
    : null;
  const legacyRule = canonicalRule
    ? null
    : automationRuleFromLegacyWorkflow(project, backendRules);
  const runtimeDefinition =
    canonicalRule?.eventConfig.runtime_workflow_definition;
  const internalDefinition =
    runtimeDefinition &&
    typeof runtimeDefinition === "object" &&
    !Array.isArray(runtimeDefinition)
      ? (runtimeDefinition as ProjectWorkflowDefinition)
      : project.workflow_definition;
  const internalRuleIds = new Set(
    [
      internalDefinition?.ai_automation_rule_id,
      ...(internalDefinition?.nodes ?? []).map(
        (node) => node.automation_rule_id,
      ),
    ].filter(
      (ruleId): ruleId is string =>
        Boolean(ruleId) && ruleId !== canonicalRule?.id,
    ),
  );
  const visibleBackendRules = backendRules.filter(
    (rule) => !internalRuleIds.has(rule.id),
  );
  const rules = [
    ...(legacyRule ? [legacyRule] : []),
    ...visibleBackendRules.map(automationRuleFromBackend),
  ];
  const runSources = rules.flatMap((rule) => {
    if (rule.origin === "automation") {
      return [{ automationId: rule.id, ruleId: rule.id }];
    }
    return backendRules
      .filter((backendRule) => internalRuleIds.has(backendRule.id))
      .map((backendRule) => ({
        automationId: backendRule.id,
        ruleId: rule.id,
      }));
  });
  return { rules, runSources };
}

export function clearedLegacyWorkflow(
  definition: ProjectWorkflowDefinition,
): ProjectWorkflowDefinition {
  return {
    version: definition.version,
    stage_mode: "none",
    advancement_policy: "manual",
    coordinator_prompt: "",
    approval_policy: "required",
    ai_automation_rule_id: null,
    execution_config: null,
    nodes: [],
  };
}

async function loadRuns(
  api: AutomationCloudApi,
  projectId: string,
  runSources: AutomationRunSource[],
  rules: AutomationUiRule[],
) {
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const groups = await Promise.all(
    runSources.map(async (source) => {
      const rule = rulesById.get(source.ruleId);
      if (!rule) return [];
      const backendRuns = await api.listRuns(projectId, source.automationId);
      return backendRuns.map((run) => automationRunFromBackend(run, rule));
    }),
  );
  return groups
    .flat()
    .sort(
      (left, right) =>
        Date.parse(right.triggeredAt) - Date.parse(left.triggeredAt),
    );
}

export function useAutomationCloudState<P extends AutomationProject>({
  api,
  cacheSource = api,
  projectApi,
  incomingHooksApi,
  project,
  currentUserId = project.current_user_id,
  canManage,
  legacyUpgradeRequiredMessage,
  serviceUnavailableMessage,
  managePermissionMessage,
  runtimeUserRequiredMessage,
  duplicateName,
  onProjectUpdated,
  onRunRefreshError,
}: UseAutomationCloudStateOptions<P>) {
  const projectId = String(project.id);
  const cacheKey = `${projectId}:${String(currentUserId ?? "")}`;
  const projectRef = useRef(project);
  const onProjectUpdatedRef = useRef(onProjectUpdated);
  const initialCache = readRuleCache(cacheKey, cacheSource);
  const scopeRef = useRef<AutomationScopeToken>({
    cacheKey,
    api,
    cacheSource,
  });
  if (
    scopeRef.current.cacheKey !== cacheKey ||
    scopeRef.current.api !== api ||
    scopeRef.current.cacheSource !== cacheSource
  ) {
    scopeRef.current = { cacheKey, api, cacheSource };
  }
  const scope = scopeRef.current;
  const [rules, setRules] = useState<AutomationUiRule[]>(
    () => initialCache?.rules ?? [],
  );
  const [runs, setRuns] = useState<AutomationUiRun[]>([]);
  const [runSources, setRunSources] = useState<AutomationRunSource[]>(
    () => initialCache?.runSources ?? [],
  );
  const [runsLoaded, setRunsLoaded] = useState(false);
  const runsRequestRef = useRef<AutomationRunsRequest | null>(null);
  const [loading, setLoading] = useState(() => !initialCache);
  const [error, setError] = useState("");
  const [stateScope, setStateScope] = useState(scope);
  const [eventSourceCatalog, setEventSourceCatalog] = useState<
    AutomationEventSourceCatalogItem[]
  >([]);

  useEffect(() => {
    const cached = readRuleCache(cacheKey, cacheSource);
    runsRequestRef.current = null;
    setRules(cached?.rules ?? []);
    setRuns([]);
    setRunSources(cached?.runSources ?? []);
    setRunsLoaded(false);
    setLoading(!cached);
    setError("");
    setEventSourceCatalog([]);
    setStateScope(scope);
  }, [cacheKey, cacheSource, scope]);

  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  useEffect(() => {
    onProjectUpdatedRef.current = onProjectUpdated;
  }, [onProjectUpdated]);

  const publishProject = useCallback((updatedProject: P) => {
    projectRef.current = updatedProject;
    onProjectUpdatedRef.current?.(updatedProject);
  }, []);

  const load = useCallback(
    async ({
      force = false,
    }: { force?: boolean } = {}): Promise<AutomationRuleSnapshot> => {
      if (!api) {
        if (scopeRef.current === scope) {
          setRules([]);
          setRunSources([]);
          setError(serviceUnavailableMessage);
          setLoading(false);
        }
        return { rules: [], runSources: [] };
      }
      const cached = readRuleCache(cacheKey, cacheSource);
      if (
        cached &&
        !force &&
        Date.now() - cached.updatedAt < AUTOMATION_CACHE_FRESH_MS
      ) {
        if (scopeRef.current === scope) setLoading(false);
        return cached;
      }
      if (!cached && scopeRef.current === scope) setLoading(true);
      try {
        let request = ruleLoads.get(cacheKey);
        if (!request || request.source !== cacheSource || request.api !== api) {
          const loadProject = projectRef.current;
          const promise = api.list(projectId).then(async (backendRules) => {
            const legacyRule = loadProject.workflow_automation_id
              ? null
              : automationRuleFromLegacyWorkflow(loadProject, backendRules);
            if (!legacyRule)
              return buildRuleSnapshot(loadProject, backendRules);
            if (!canManage || currentUserId == null) {
              throw new Error(legacyUpgradeRequiredMessage);
            }
            const workflowDefinition =
              legacyWorkflowFromAutomationRule(legacyRule);
            const result = await api.migrateWorkflow(projectId, {
              projectVersion: loadProject.version,
              automation: automationInputFromUi(legacyRule, currentUserId),
              workflowDefinition,
            });
            const updatedProject = {
              ...loadProject,
              workflow_automation_id: result.workflowAutomationId,
              workflow_definition: clearedLegacyWorkflow(workflowDefinition),
              version: result.projectVersion,
            };
            return {
              ...buildRuleSnapshot(updatedProject, [
                result.automation,
                ...backendRules,
              ]),
              updatedProject,
            };
          });
          request = { source: cacheSource ?? api, api, promise };
          ruleLoads.set(cacheKey, request);
          const clearRequest = () => {
            if (ruleLoads.get(cacheKey)?.promise === promise)
              ruleLoads.delete(cacheKey);
          };
          void promise.then(clearRequest, clearRequest);
        }
        const snapshot = await request.promise;
        if (scopeRef.current === scope) {
          ruleCache.set(cacheKey, {
            ...snapshot,
            source: cacheSource ?? api,
            updatedAt: Date.now(),
          });
          if (snapshot.updatedProject)
            publishProject(snapshot.updatedProject as P);
          setRules(snapshot.rules);
          setRunSources(snapshot.runSources);
          setError("");
        }
        return snapshot;
      } catch (loadError) {
        if (!cached && scopeRef.current === scope)
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
        if (cached) return cached;
        throw loadError;
      } finally {
        if (scopeRef.current === scope) setLoading(false);
      }
    },
    [
      api,
      cacheSource,
      cacheKey,
      canManage,
      currentUserId,
      legacyUpgradeRequiredMessage,
      projectId,
      publishProject,
      scope,
      serviceUnavailableMessage,
    ],
  );

  useEffect(() => {
    void Promise.resolve()
      .then(() => load())
      .catch(() => undefined);
  }, [load]);

  useEffect(() => {
    if (!incomingHooksApi) return;
    void incomingHooksApi
      .catalog()
      .then((catalog) => {
        if (scopeRef.current === scope) setEventSourceCatalog(catalog);
      })
      .catch((loadError) => {
        if (scopeRef.current === scope)
          setError(
            loadError instanceof Error ? loadError.message : String(loadError),
          );
      });
  }, [incomingHooksApi, projectId, scope]);

  const refreshRuns = useCallback(async () => {
    if (!api) throw new Error(serviceUnavailableMessage);
    const activeRequest = runsRequestRef.current;
    if (activeRequest?.scope === scope) return activeRequest.promise;
    const request = load()
      .then((snapshot) =>
        loadRuns(api, projectId, snapshot.runSources, snapshot.rules),
      )
      .then((refreshedRuns) => {
        if (scopeRef.current === scope) {
          setRuns(refreshedRuns);
          setRunsLoaded(true);
        }
        return refreshedRuns;
      })
      .finally(() => {
        if (runsRequestRef.current?.promise === request)
          runsRequestRef.current = null;
      });
    runsRequestRef.current = { scope, promise: request };
    return request;
  }, [api, load, projectId, scope, serviceUnavailableMessage]);

  useEffect(() => {
    if (!api || !runsLoaded) return;
    let disposed = false;
    let refreshing = false;
    const refresh = async () => {
      if (disposed || refreshing || document.visibilityState !== "visible")
        return;
      refreshing = true;
      try {
        await refreshRuns();
      } catch (refreshError) {
        onRunRefreshError?.(refreshError);
      } finally {
        refreshing = false;
      }
    };
    const interval = window.setInterval(
      () => void refresh(),
      AUTOMATION_RUN_REFRESH_MS,
    );
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [api, onRunRefreshError, refreshRuns, runsLoaded]);

  useEffect(() => {
    if (!api || stateScope !== scope || loading || error) return;
    const cached = readRuleCache(cacheKey, cacheSource);
    ruleCache.set(cacheKey, {
      source: cacheSource ?? api,
      rules,
      runSources,
      updatedAt: cached?.updatedAt ?? Date.now(),
    });
  }, [
    api,
    cacheKey,
    cacheSource,
    error,
    loading,
    rules,
    runSources,
    scope,
    stateScope,
  ]);

  const requireManageApi = useCallback(() => {
    if (!api) throw new Error(serviceUnavailableMessage);
    if (!canManage) throw new Error(managePermissionMessage);
    return api;
  }, [api, canManage, managePermissionMessage, serviceUnavailableMessage]);

  const persistRule = useCallback(
    async (rule: AutomationUiRule) => {
      const cloudApi = requireManageApi();
      if (currentUserId == null) throw new Error(runtimeUserRequiredMessage);
      const currentProject = projectRef.current;
      if (rule.origin === "legacy_workflow") {
        const workflowDefinition = legacyWorkflowFromAutomationRule(rule);
        const result = await cloudApi.migrateWorkflow(projectId, {
          projectVersion: currentProject.version,
          automation: automationInputFromUi(rule, currentUserId),
          workflowDefinition,
        });
        const updatedProject = {
          ...currentProject,
          workflow_automation_id: result.workflowAutomationId,
          workflow_definition: clearedLegacyWorkflow(workflowDefinition),
          version: result.projectVersion,
        };
        const mapped = automationRuleFromBackend(result.automation);
        if (scopeRef.current !== scope) return mapped;
        publishProject(updatedProject);
        setRules((current) =>
          current.map((candidate) =>
            candidate.id === rule.id ? mapped : candidate,
          ),
        );
        setRunSources((current) => [
          { automationId: mapped.id, ruleId: mapped.id },
          ...current.filter(
            (source) =>
              source.ruleId !== rule.id && source.automationId !== mapped.id,
          ),
        ]);
        setError("");
        return mapped;
      }
      const input = automationInputFromUi(rule, currentUserId);
      const saved = rule.persisted
        ? await cloudApi.update(projectId, rule.id, {
            ...input,
            version: rule.version,
          })
        : await cloudApi.create(projectId, input);
      const mapped = automationRuleFromBackend(saved);
      if (scopeRef.current !== scope) return mapped;
      setRules((current) => {
        const exists = current.some((candidate) => candidate.id === mapped.id);
        return exists
          ? current.map((candidate) =>
              candidate.id === mapped.id ? mapped : candidate,
            )
          : [mapped, ...current];
      });
      setRunSources((current) =>
        current.some((source) => source.automationId === mapped.id)
          ? current
          : [{ automationId: mapped.id, ruleId: mapped.id }, ...current],
      );
      setError("");
      return mapped;
    },
    [
      currentUserId,
      projectId,
      publishProject,
      requireManageApi,
      runtimeUserRequiredMessage,
      scope,
    ],
  );

  const toggleRule = useCallback(
    async (rule: AutomationUiRule, enabled: boolean) => {
      const cloudApi = requireManageApi();
      if (rule.origin === "legacy_workflow")
        return persistRule({ ...rule, enabled });
      const mapped = automationRuleFromBackend(
        await cloudApi.update(projectId, rule.id, {
          version: rule.version,
          enabled,
        }),
      );
      if (scopeRef.current !== scope) return mapped;
      setRules((current) =>
        current.map((candidate) =>
          candidate.id === mapped.id ? mapped : candidate,
        ),
      );
      return mapped;
    },
    [persistRule, projectId, requireManageApi, scope],
  );

  const deleteRule = useCallback(
    async (rule: AutomationUiRule) => {
      const cloudApi = requireManageApi();
      const currentProject = projectRef.current;
      if (rule.origin === "legacy_workflow") {
        const updatedProject = await projectApi.clearLegacyWorkflow(
          currentProject,
          currentProject.workflow_definition ?? {
            version: 1,
            nodes: [],
          },
        );
        if (scopeRef.current !== scope) return;
        publishProject(updatedProject);
      } else {
        const result = await cloudApi.remove(projectId, rule.id);
        if (scopeRef.current !== scope) return;
        if (currentProject.workflow_automation_id === rule.id) {
          publishProject({
            ...currentProject,
            workflow_automation_id: result.workflowAutomationId,
            version: result.projectVersion,
          });
        }
      }
      setRules((current) =>
        current.filter((candidate) => candidate.id !== rule.id),
      );
      setRuns((current) => current.filter((run) => run.ruleId !== rule.id));
      setRunSources((current) =>
        current.filter((source) => source.ruleId !== rule.id),
      );
    },
    [projectApi, projectId, publishProject, requireManageApi, scope],
  );

  const duplicateRule = useCallback(
    (rule: AutomationUiRule) =>
      persistRule({
        ...rule,
        id: `draft-${crypto.randomUUID()}`,
        persisted: false,
        origin: "automation",
        legacyDefinition: null,
        version: 1,
        name: duplicateName(rule.name),
        enabled: false,
      }),
    [duplicateName, persistRule],
  );

  const runRule = useCallback(
    async (rule: AutomationUiRule) => {
      if (!api) throw new Error(serviceUnavailableMessage);
      const run = await api.runNow(projectId, rule.id);
      if (scopeRef.current !== scope) return;
      setRuns((current) => [
        automationRunFromBackend(run, rule),
        ...current.filter((item) => item.id !== run.id),
      ]);
    },
    [api, projectId, scope, serviceUnavailableMessage],
  );

  return {
    rules: stateScope === scope ? rules : (initialCache?.rules ?? []),
    runs: stateScope === scope ? runs : [],
    loading: stateScope === scope ? loading : !initialCache,
    error: stateScope === scope ? error : "",
    eventSourceCatalog: stateScope === scope ? eventSourceCatalog : [],
    reload: async () => {
      await load({ force: true });
    },
    refreshRuns,
    persistRule,
    toggleRule,
    duplicateRule,
    deleteRule,
    runRule: api ? runRule : undefined,
  };
}
