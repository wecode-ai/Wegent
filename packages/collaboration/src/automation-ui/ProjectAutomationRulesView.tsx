import { useCallback } from "react";

import {
  useAutomationCloudState,
  type AutomationCloudApi,
  type AutomationIncomingHooksApi,
  type AutomationProject,
  type AutomationProjectApi,
} from "../automation";
import { AutomationPolicyView } from "./AutomationPolicyView";
import {
  AutomationUiHostProvider,
  useTranslation,
  type AutomationUiHost,
} from "./AutomationUiHost";
import type { AutomationIncomingHookUiApi } from "./AutomationRulesView.types";

export interface ProjectAutomationRulesViewProps<P extends AutomationProject> {
  automationApi?: AutomationCloudApi;
  automationCacheSource?: object;
  projectApi: AutomationProjectApi<P>;
  incomingHooksApi?: AutomationIncomingHooksApi & AutomationIncomingHookUiApi;
  uiHost: AutomationUiHost;
  locale?: "zh-CN" | "en" | string;
  project: P;
  currentUserId?: string | number;
  canManage: boolean;
  onProjectUpdated?: (project: P) => void;
  onRunRefreshError?: (error: unknown) => void;
  onOpenIssue?: (issueId: string) => void;
}

export function ProjectAutomationRulesView<P extends AutomationProject>(
  props: ProjectAutomationRulesViewProps<P>,
) {
  return (
    <AutomationUiHostProvider host={props.uiHost} locale={props.locale}>
      <ProjectAutomationRulesContent {...props} />
    </AutomationUiHostProvider>
  );
}

function ProjectAutomationRulesContent<P extends AutomationProject>({
  automationApi,
  automationCacheSource = automationApi,
  projectApi,
  incomingHooksApi,
  project,
  currentUserId = project.current_user_id,
  canManage,
  onProjectUpdated,
  onRunRefreshError,
  onOpenIssue,
}: ProjectAutomationRulesViewProps<P>) {
  const { t } = useTranslation("common");
  const automation = useAutomationCloudState({
    api: automationApi,
    cacheSource: automationCacheSource,
    projectApi,
    incomingHooksApi,
    project,
    currentUserId,
    canManage,
    legacyUpgradeRequiredMessage: t("automation.error.legacyUpgrade"),
    serviceUnavailableMessage: t("automation.error.serviceUnavailable"),
    managePermissionMessage: t("automation.error.managePermission"),
    runtimeUserRequiredMessage: t("automation.error.runtimeUserRequired"),
    duplicateName: useCallback(
      (name: string) => t("automation.rule.copySuffix", { name }),
      [t],
    ),
    onProjectUpdated,
    onRunRefreshError,
  });

  return (
    <AutomationPolicyView
      rules={automation.rules}
      runs={automation.runs}
      loading={automation.loading}
      error={automation.error}
      canManage={canManage}
      projectTags={project.tags}
      eventSourceCatalog={automation.eventSourceCatalog}
      projectIncomingHookApi={incomingHooksApi}
      projectId={String(project.id)}
      project={project}
      onReload={automation.reload}
      onLoadRuns={automation.refreshRuns}
      onOpenIssue={onOpenIssue}
      onRunRule={automation.runRule}
      onSaveRule={automation.persistRule}
      onToggleRule={automation.toggleRule}
      onDuplicateRule={automation.duplicateRule}
      onDeleteRule={automation.deleteRule}
    />
  );
}
