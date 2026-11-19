import type {
  RuntimeProjectRef,
  RuntimeProjectSpaceRef,
  RuntimeProjectQuickPhrase,
} from "./runtime-task-api-types";
import { runtimeProjectUiId } from "./runtime-project";
import { modelSelectionFromRuntimeHandle } from "./runtime-model-selection";

export function parseRuntimeRemoteProjectStateId(
  stateId: string,
): { hostId: string; projectKey: string } | null {
  const prefix = "wegent-remote:";
  if (!stateId.startsWith(prefix)) return null;
  const encodedIdentity = stateId.slice(prefix.length);
  const separatorIndex = encodedIdentity.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === encodedIdentity.length - 1)
    return null;
  try {
    const hostId = decodeURIComponent(
      encodedIdentity.slice(0, separatorIndex),
    ).trim();
    const projectKey = decodeURIComponent(
      encodedIdentity.slice(separatorIndex + 1),
    ).trim();
    return hostId && projectKey ? { hostId, projectKey } : null;
  } catch {
    return null;
  }
}

/** Shared PC projection of executor workspace metadata; ownership is never inferred from a label. */
export function runtimeProjectRefFromWorkspace(
  workspace: Record<string, unknown>,
  {
    projectKey,
    workspacePath,
    label,
    stateDeviceId,
    workspaceDeviceId,
    requireExplicitProjectRoots = false,
  }: {
    projectKey: string;
    workspacePath: string;
    label: string;
    stateDeviceId: string;
    workspaceDeviceId: string;
    requireExplicitProjectRoots?: boolean;
  },
): RuntimeProjectRef {
  const rawRoots = Array.isArray(workspace.projectRoots)
    ? workspace.projectRoots
    : Array.isArray(workspace.project_roots)
      ? workspace.project_roots
      : requireExplicitProjectRoots
        ? undefined
        : [workspacePath];
  const projectKind =
    stringValue(workspace.projectKind) ??
    stringValue(workspace.project_kind) ??
    "local";
  const projectSource =
    stringValue(workspace.projectSource) ??
    stringValue(workspace.project_source) ??
    "legacy_root";
  const projectSidebarOrder =
    workspace.projectSidebarOrder ?? workspace.project_sidebar_order;
  const projectPinnedOrder =
    workspace.projectPinnedOrder ?? workspace.project_pinned_order;
  const rawDefaultProjectSpace = recordValue(
    workspace.defaultProjectSpace ?? workspace.default_project_space,
  );
  const defaultProjectStore = stringValue(rawDefaultProjectSpace.projectStore);
  const defaultProjectId = stringValue(rawDefaultProjectSpace.projectId);
  const defaultProjectSpace: RuntimeProjectSpaceRef | null =
    (defaultProjectStore === "local" || defaultProjectStore === "backend") &&
    defaultProjectId
      ? { projectStore: defaultProjectStore, projectId: defaultProjectId }
      : null;
  const rawProjectAiSettings = recordValue(
    workspace.projectAiSettings ?? workspace.project_ai_settings,
  );
  const projectInstructions =
    typeof rawProjectAiSettings.instructions === "string"
      ? rawProjectAiSettings.instructions
      : undefined;
  const projectModelSelection = modelSelectionFromRuntimeHandle({
    modelSelection:
      rawProjectAiSettings.modelSelection ??
      rawProjectAiSettings.model_selection,
  });
  const projectPlugins = Array.isArray(rawProjectAiSettings.plugins)
    ? rawProjectAiSettings.plugins
        .map((plugin) => {
          const value = recordValue(plugin);
          const id = stringValue(value.id);
          const pluginName = stringValue(value.pluginName ?? value.plugin_name);
          const marketplaceId = stringValue(
            value.marketplaceId ?? value.marketplace_id,
          );
          const displayName = stringValue(
            value.displayName ?? value.display_name,
          );
          return id && pluginName && marketplaceId
            ? {
                id,
                pluginName,
                marketplaceId,
                displayName: displayName || pluginName,
              }
            : null;
        })
        .filter(
          (plugin): plugin is NonNullable<typeof plugin> => plugin !== null,
        )
    : [];
  const rawProjectQuickPhrases =
    rawProjectAiSettings.quickPhrases ?? rawProjectAiSettings.quick_phrases;
  const projectQuickPhrases = Array.isArray(rawProjectQuickPhrases)
    ? rawProjectQuickPhrases
        .map((phrase): RuntimeProjectQuickPhrase | null => {
          const value = recordValue(phrase);
          const id = stringValue(value.id);
          const title = stringValue(value.title);
          const content = stringValue(value.content);
          const mode = stringValue(value.mode);
          return id &&
            title &&
            content &&
            (mode === "normal" || mode === "plan" || mode === "goal")
            ? { id, title, content, mode }
            : null;
        })
        .filter(
          (phrase): phrase is NonNullable<typeof phrase> => phrase !== null,
        )
    : [];
  const aiSettings =
    projectInstructions !== undefined ||
    projectModelSelection ||
    projectPlugins.length > 0 ||
    projectQuickPhrases.length > 0
      ? {
          ...(projectInstructions !== undefined
            ? { instructions: projectInstructions }
            : {}),
          modelSelection: projectModelSelection,
          ...(projectPlugins.length > 0 ? { plugins: projectPlugins } : {}),
          ...(projectQuickPhrases.length > 0
            ? { quickPhrases: projectQuickPhrases }
            : {}),
        }
      : null;
  const remoteTarget =
    projectSource === "remote_project"
      ? parseRuntimeRemoteProjectStateId(projectKey)
      : null;
  const ownerProjectKey =
    stringValue(workspace.ownerProjectKey) ??
    remoteTarget?.projectKey ??
    (projectSource === "remote_project" ? null : projectKey);
  return {
    key: projectKey,
    ...(projectSource === "remote_project"
      ? { sidebarStateKey: projectKey }
      : {}),
    id: runtimeProjectUiId({
      key: ownerProjectKey ?? projectKey,
      stateDeviceId: ownerProjectKey ? workspaceDeviceId : stateDeviceId,
      name: label,
    }),
    name: label,
    kind: projectKind,
    source: projectSource,
    stateDeviceId: stateDeviceId,
    ownerDeviceId: workspaceDeviceId,
    ownerProjectKey: ownerProjectKey ?? null,
    ...(rawRoots
      ? {
          roots: rawRoots
            .map((root) => stringValue(root))
            .filter((root): root is string => Boolean(root))
            .map((path) => ({ kind: "local" as const, path })),
        }
      : {}),
    sidebarOrder:
      typeof projectSidebarOrder === "number" &&
      Number.isInteger(projectSidebarOrder)
        ? projectSidebarOrder
        : null,
    pinned:
      workspace.projectPinned === true || workspace.project_pinned === true,
    pinnedOrder:
      typeof projectPinnedOrder === "number" &&
      Number.isInteger(projectPinnedOrder)
        ? projectPinnedOrder
        : null,
    active:
      workspace.projectActive === true || workspace.project_active === true,
    appearance: (workspace.projectAppearance ??
      workspace.project_appearance ??
      null) as RuntimeProjectRef["appearance"] | null,
    ...(defaultProjectSpace ? { defaultProjectSpace } : {}),
    ...(aiSettings ? { aiSettings } : {}),
  };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function recordValue(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
