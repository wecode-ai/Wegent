import { useEffect, useState } from "react";
import { Clock, Folder, Webhook, X } from "lucide-react";
import type { CollaborationTranslate } from "../i18n";
import type {
  AutomationConnectionProvider,
  ConnectionRulesApi,
} from "../automation/connectionRules";
import { ConnectionRuleDialog } from "../automation/ConnectionRuleDialog";
import {
  ConnectionTypeRow,
  connectionProviderIcon,
} from "../automation/ConnectionSetup";

export function ProjectRuleConnectionPicker({
  api,
  translate,
  returnFocus,
  onClose,
  onSelect,
  hasIncomingHooks,
}: {
  api?: ConnectionRulesApi;
  translate: CollaborationTranslate;
  returnFocus: HTMLElement | null;
  onClose(): void;
  onSelect(
    value: "projects" | "time" | "webhook" | AutomationConnectionProvider,
  ): void;
  hasIncomingHooks: boolean;
}) {
  const [providers, setProviders] = useState<AutomationConnectionProvider[]>(
    [],
  );
  const [loading, setLoading] = useState(Boolean(api));
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!api) return;
    let active = true;
    setLoading(true);
    setError("");
    void api
      .providers()
      .then((items) => {
        if (active) setProviders(items);
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, revision]);
  return (
    <ConnectionRuleDialog
      label={translate("automation_rules.choose_connection", "选择连接")}
      returnFocus={returnFocus}
    >
      <div
        className="flex min-h-0 flex-col"
        data-testid="project-rule-connection-picker"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-5 py-4">
          <h2 className="heading-small">
            {translate("automation_rules.choose_connection", "选择连接")}
          </h2>
          <button
            type="button"
            data-testid="project-rule-connection-close"
            aria-label={translate("common.close", "关闭")}
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 space-y-3 overflow-y-auto p-5">
          <p className="text-sm text-text-muted">
            {translate(
              "automation_rules.choose_connection_help",
              "先选择连接，再设置何时触发、如何处理。",
            )}
          </p>
          <div className="space-y-1">
            <ConnectionTypeRow
              icon={Folder}
              label={translate("automation_rules.projects", "协作项目")}
              testId="project-rule-connection-projects"
              onSelect={() => onSelect("projects")}
            />
            <ConnectionTypeRow
              icon={Clock}
              label={translate("automation_rules.time", "时间")}
              testId="project-rule-connection-time"
              onSelect={() => onSelect("time")}
            />
            {providers.map((provider) => (
              <div key={provider.id}>
                <ConnectionTypeRow
                  icon={connectionProviderIcon(provider.id)}
                  label={provider.displayName}
                  testId={`project-rule-connection-${provider.id}`}
                  disabled={provider.availability.status !== "ready"}
                  onSelect={() => onSelect(provider)}
                />
                {provider.availability.status !== "ready" && (
                  <p className="px-8 text-xs text-text-muted">
                    {translate(
                      "automation_rules.connect_personal_first",
                      "请先在个人分身连接此账号并完成授权。",
                    )}
                  </p>
                )}
              </div>
            ))}
            {hasIncomingHooks && (
              <ConnectionTypeRow
                icon={Webhook}
                label={translate(
                  "automation_rules.incoming_events",
                  "已接入的外部事件",
                )}
                testId="project-rule-connection-webhook"
                onSelect={() => onSelect("webhook")}
              />
            )}
          </div>
          {loading && (
            <p role="status" className="text-sm text-text-muted">
              {translate("common.loading", "加载中…")}
            </p>
          )}
          {error && (
            <div role="alert" className="space-y-2 text-sm">
              <p>{error}</p>
              <button
                type="button"
                data-testid="project-rule-connection-retry"
                onClick={() => setRevision((value) => value + 1)}
                className="min-h-9 underline"
              >
                {translate("common.retry", "重试")}
              </button>
            </div>
          )}
        </div>
      </div>
    </ConnectionRuleDialog>
  );
}
