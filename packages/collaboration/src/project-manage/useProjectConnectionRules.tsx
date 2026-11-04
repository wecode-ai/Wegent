// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useState } from "react";
import { ConnectionRulesPanel } from "../automation/ConnectionRulesPanel";
import type {
  ConnectionRulesApi,
  ConnectionProjectTarget,
  ConnectionAutomationRule,
} from "../automation/connectionRules";
import type { CollaborationTranslate } from "../i18n";
import type { WorkspaceAutomationRule } from "../ports/SharedWorkspaceApi";
import type { TargetKind } from "./automaticProcessing";

export interface ProjectConnectionRuleOptions {
  connectionRules?: ConnectionRulesApi;
  connectionProject?: ConnectionProjectTarget;
  renderConnectionRunnerSelection?: import("../automation/ConnectionRulesPanel").ConnectionRulesPanelProps["renderRunnerSelection"];
  onOpenConnectionIssue?(issueId: string): void | Promise<void>;
}

export function useProjectConnectionRules({
  connectionRules,
  connectionProject,
  renderConnectionRunnerSelection,
  onOpenConnectionIssue,
  rules,
  targetKinds,
  translate,
  disabled,
  onMutation,
}: ProjectConnectionRuleOptions & {
  rules: WorkspaceAutomationRule[];
  targetKinds: readonly {
    kind: TargetKind;
    options: readonly { id: string; name: string }[];
  }[];
  translate: CollaborationTranslate;
  disabled: boolean;
  onMutation(): void;
}) {
  const sourceProjectKey = JSON.stringify([
    connectionRules?.ownerScope,
    connectionProject?.store,
    connectionProject?.id,
  ]);
  const [privateRules, setPrivateRules] = useState<{
    project: string;
    ids: string[];
  } | null>(null);
  const sourceRulesChanged = useCallback(
    (rules: ConnectionAutomationRule[]) => {
      setPrivateRules({
        project: sourceProjectKey,
        ids: rules.map((rule) => rule.cloudRuleId ?? rule.id),
      });
    },
    [sourceProjectKey],
  );
  const sourcesLoading = Boolean(
    connectionRules &&
    connectionProject &&
    privateRules?.project !== sourceProjectKey,
  );
  const privateRuleIds =
    privateRules?.project === sourceProjectKey ? privateRules.ids : [];

  return {
    visibleRules: rules.filter((rule) => !privateRuleIds.includes(rule.id)),
    sourcesLoading,
    connectionRulesPanel:
      connectionRules && connectionProject ? (
        <ConnectionRulesPanel
          api={connectionRules}
          renderRunnerSelection={renderConnectionRunnerSelection}
          onOpenIssue={onOpenConnectionIssue}
          onRulesChange={sourceRulesChanged}
          onMutation={onMutation}
          project={connectionProject}
          targets={targetKinds.flatMap((target) =>
            target.options.map((option) => ({
              id: option.id,
              kind: target.kind,
              name: option.name,
            })),
          )}
          translate={translate}
          canConfigureProject={!disabled}
        />
      ) : null,
  };
}
