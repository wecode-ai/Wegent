import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import type { CollaborationTranslate } from "../i18n";
import type {
  AutomationConnectionProvider,
  AutomationConnectionResource,
  ConnectionAutomationRule,
  ConnectionProjectTarget,
  ConnectionRuleRun,
  ConnectionRulesApi,
} from "./connectionRules";
import { ConnectionRuleDialog } from "./ConnectionRuleDialog";
import { DialogForm } from "../controls/DialogForm";
import { ArrowLeft, X } from "lucide-react";
import {
  ConnectionResourcePicker,
  ConnectionSetupHeader,
  connectionProviderIcon,
  connectionResourceKey,
} from "./ConnectionSetup";
import { RuleTargetPicker } from "./RuleTargetPicker";
import { ConnectionRuleFields } from "./ConnectionRuleFields";

export interface ConnectionRulesPanelHandle {
  reset(): void;
  create(
    provider: AutomationConnectionProvider,
    returnFocus: HTMLElement | null,
    onBack: () => void,
  ): void;
}

export interface ConnectionRulesPanelProps {
  ref?: Ref<ConnectionRulesPanelHandle>;
  api: ConnectionRulesApi;
  project: ConnectionProjectTarget;
  targets: Array<{
    id: string;
    kind: ConnectionAutomationRule["targetKind"];
    name: string;
  }>;
  translate: CollaborationTranslate;
  disabled?: boolean;
  canConfigureProject?: boolean;
  className?: string;
  embedded?: boolean;
  onRulesChange?(rules: ConnectionAutomationRule[]): void;
  onMutation?(): void;
  renderRunnerSelection?(
    rule: ConnectionAutomationRule,
    onChange: (selection: ConnectionAutomationRule["runnerSelection"]) => void,
  ): ReactNode;
  onOpenIssue?(issueId: string): void | Promise<void>;
}

export function ConnectionRulesPanel(props: ConnectionRulesPanelProps) {
  return (
    <ConnectionRulesWorkspace
      key={JSON.stringify([
        props.api.ownerScope,
        props.project.store,
        props.project.id,
      ])}
      {...props}
    />
  );
}

function ConnectionRulesWorkspace({
  api,
  project,
  targets,
  translate,
  disabled = false,
  canConfigureProject = true,
  embedded = false,
  className = "mt-6 space-y-3 border-t border-border pt-4",
  onRulesChange,
  onMutation,
  renderRunnerSelection,
  onOpenIssue,
  ref,
}: ConnectionRulesPanelProps) {
  const [rules, setRules] = useState<ConnectionAutomationRule[]>([]);
  const [providers, setProviders] = useState<AutomationConnectionProvider[]>(
    [],
  );
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");
  const [resources, setResources] = useState<AutomationConnectionResource[]>(
    [],
  );
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null);
  const [step, setStep] = useState<"connection" | "rule">("connection");
  const backToConnections = useRef<(() => void) | null>(null);
  const [draft, setDraft] = useState<ConnectionAutomationRule | null>(null);
  const suspendedDrafts = useRef(
    new Map<
      string,
      {
        rule: ConnectionAutomationRule;
        resources: AutomationConnectionResource[];
        query: string;
        kind: string;
      }
    >(),
  );
  const [historyRuleId, setHistoryRuleId] = useState<string | null>(null);
  const [runs, setRuns] = useState<ConnectionRuleRun[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const searchSequence = useRef(0);
  const configurationDisabled = disabled || !canConfigureProject;
  useEffect(() => {
    if (!loading) onRulesChange?.(rules);
  }, [rules, onRulesChange, loading]);
  const fieldClass =
    "min-h-11 w-full rounded-md border border-border bg-background px-3 py-2 text-sm md:min-h-8";
  useEffect(() => {
    let active = true;
    const current = ++generation.current;
    void api
      .list({ id: project.id, store: project.store })
      .then((items) => {
        if (active) setRules(items);
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
      generation.current = current + 1;
    };
  }, [api, project.id, project.store, reload]);
  useEffect(() => {
    let active = true;
    const interval = setInterval(() => {
      if (busy) return;
      void api
        .list({ id: project.id, store: project.store })
        .then((items) => {
          if (active) setRules(items);
        })
        .catch(() => {});
      if (historyRuleId)
        void api
          .runs(historyRuleId!)
          .then((items) => {
            if (active) setRuns(items);
          })
          .catch(() => {});
    }, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [api, project.id, project.store, busy, historyRuleId]);
  const label = (value: string) =>
    translate(`automation_rules.values.${value.replaceAll(".", "_")}`, value);
  async function perform(action: (active: () => boolean) => Promise<void>) {
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      await action(() => current === generation.current);
    } catch (cause) {
      if (current === generation.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  function reloadRules() {
    setDraft(null);
    setHistoryRuleId(null);
    setResources([]);
    setRules([]);
    setError("");
    setLoading(true);
    setReload((value) => value + 1);
  }
  useImperativeHandle(ref, () => ({
    reset() {
      suspendedDrafts.current.clear();
      setDraft(null);
    },
    create(provider, focusTarget, onBack) {
      if (configurationDisabled || busy) return;
      setReturnFocus(focusTarget);
      backToConnections.current = onBack;
      setProviders([provider]);
      const suspended = suspendedDrafts.current.get(provider.id);
      if (suspended) {
        setKind(suspended.kind);
        setQuery(suspended.query);
        setResources(suspended.resources);
        setDraft(suspended.rule);
        setStep("connection");
        setError("");
        return;
      }
      setKind(provider.resourceKinds[0] ?? "");
      setQuery("");
      setResources([]);
      setError("");
      setHistoryRuleId(null);
      setRuns([]);
      setStep("connection");
      const target =
        targets.find((item) => item.kind === "agent") ?? targets[0];
      setDraft({
        id: "connection-rule-" + crypto.randomUUID(),
        version: 0,
        name: "",
        enabled: true,
        source: {
          providerId: provider.id,
          id: "",
          profile: "",
          kind: provider.resourceKinds[0] ?? "",
          name: "",
        },
        eventType: provider.eventTypes?.[0] ?? "",
        project,
        targetKind: target?.kind ?? "agent",
        targetId: target?.id ?? "",
        publication: { title: "", instruction: "" },
      });
    },
  }));
  const provider = providers.find(
    (item) => item.id === draft?.source.providerId,
  );
  const selectableResources =
    draft?.source.id &&
    !resources.some(
      (resource) => JSON.stringify(resource) === JSON.stringify(draft.source),
    )
      ? [draft.source, ...resources]
      : resources;
  return (
    <section className={className} data-testid="connection-automation-rules">
      {!embedded && (
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">
            {translate("automation_rules.external_rules", "外部数据源规则")}
          </h3>
        </div>
      )}
      {(!embedded || rules.length > 0) && (
        <p className="text-xs text-text-secondary">
          {translate(
            "automation_rules.private_notice",
            "原始消息和账号保持私有。只有配置的发布结果会进入项目。来源设置仅在采集设备上由本人管理。",
          )}
        </p>
      )}
      {!canConfigureProject && (
        <p
          className="text-xs text-text-secondary"
          data-testid="connection-rules-project-readonly"
        >
          {translate(
            "automation_rules.private_management_hint",
            "当前不能修改项目规则，仍可查看记录或删除本机规则。",
          )}
        </p>
      )}
      {error && !draft && (
        <div role="alert" data-testid="connection-rule-error">
          {error}
          {
            <button
              type="button"
              className="min-h-11 px-2 underline"
              data-testid="connection-rule-reload"
              onClick={reloadRules}
            >
              {draft
                ? translate(
                    "automation_rules.discard_reload",
                    "放弃未保存修改并重新加载",
                  )
                : translate("automation_rules.retry", "重试")}
            </button>
          }
        </div>
      )}
      {loading && (
        <p role="status" data-testid="connection-rules-loading">
          {translate("automation_rules.loading", "正在加载规则…")}
        </p>
      )}
      {!embedded && !loading && !error && rules.length === 0 && (
        <p className="text-sm text-text-secondary">
          {translate("automation_rules.empty", "暂无外部数据源规则")}
        </p>
      )}
      <div className="divide-y divide-border">
        {rules.map((rule) => (
          <div key={rule.id} className="flex flex-wrap items-center gap-2 py-3">
            <button
              type="button"
              disabled={configurationDisabled || busy}
              className="min-h-11 min-w-0 flex-1 text-left text-sm"
              data-testid={`connection-rule-edit-${rule.id}`}
              onClick={(event) => {
                setReturnFocus(event.currentTarget);
                void perform(async (active) => {
                  const items = await api.providers();
                  if (!active()) return;
                  setProviders(items);
                  setStep("rule");
                  backToConnections.current = null;
                  setQuery("");
                  setKind(rule.source.kind);
                  setResources([rule.source]);
                  setDraft(rule);
                });
              }}
            >
              <strong className="block font-medium">{rule.name}</strong>
              <span className="text-xs text-text-secondary">
                {rule.source.name} · {label(rule.eventType)} →{" "}
                {rule.publication.title} ·{" "}
                {rule.enabled
                  ? translate("automation_rules.enabled", "已启用")
                  : translate("automation_rules.disabled", "已停用")}
                {rule.lastRunStatus ? ` · ${label(rule.lastRunStatus)}` : ""}
                {rule.collectionError
                  ? ` · ${translate("automation_rules.source_failed", "来源连接中断，请检查授权或网络后重新检查")}`
                  : ""}
              </span>
              {rule.cloudSyncError && (
                <span
                  className="block text-xs text-text-secondary"
                  data-testid={`connection-rule-cloud-sync-${rule.id}`}
                >
                  {translate(
                    "automation_rules.project_unavailable",
                    "云项目暂时无法同步，请检查网络或项目权限。",
                  )}
                </span>
              )}
              <span className="block text-xs text-text-secondary">
                {[
                  rule.condition?.contains &&
                    `${translate("automation_rules.contains", "包含")}: ${rule.condition.contains}`,
                  rule.condition?.senderId &&
                    `${translate("automation_rules.sender", "发送者")}: ${rule.condition.senderId}`,
                  targets.find(
                    (target) =>
                      target.id === rule.targetId &&
                      target.kind === rule.targetKind,
                  )?.name,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
            <button
              type="button"
              className="min-h-11 px-2 text-sm underline"
              disabled={disabled || busy}
              data-testid={`connection-rule-history-${rule.id}`}
              onClick={() =>
                void perform(async (active) => {
                  const items = await api.runs(rule.id);
                  if (active()) {
                    setHistoryRuleId(rule.id);
                    setRuns(items);
                  }
                })
              }
            >
              {translate("automation_rules.history", "运行记录")}
            </button>
            {rule.collectionError && api.retrySource && (
              <button
                type="button"
                disabled={disabled || busy}
                className="min-h-11 px-2 text-sm underline"
                data-testid={`connection-rule-retry-source-${rule.id}`}
                onClick={() =>
                  void perform(async (active) => {
                    await api.retrySource!(rule.id);
                    const items = await api.list(project);
                    if (active()) setRules(items);
                  })
                }
              >
                {translate("automation_rules.recheck_source", "重新检查来源")}
              </button>
            )}
            {canConfigureProject && (
              <button
                type="button"
                disabled={configurationDisabled || busy}
                className="min-h-11 px-2 text-sm underline"
                data-testid={`connection-rule-toggle-${rule.id}`}
                onClick={() =>
                  void perform(async (active) => {
                    await api.save({ ...rule, enabled: !rule.enabled });
                    onMutation?.();
                    const items = await api.list(project);
                    if (!active()) return;
                    setRules(items);
                    setDraft(null);
                  })
                }
              >
                {rule.enabled
                  ? translate("automation_rules.disable", "停用")
                  : translate("automation_rules.enable", "启用")}
              </button>
            )}
            <button
              type="button"
              disabled={disabled || busy}
              className="min-h-11 px-2 text-sm underline"
              data-testid={`connection-rule-remove-${rule.id}`}
              onClick={() =>
                void perform(async (active) => {
                  await api.remove(rule.id, rule.version);
                  onMutation?.();
                  const items = await api.list(project);
                  if (!active()) return;
                  setRules(items);
                  setDraft(null);
                  if (historyRuleId === rule.id) {
                    setHistoryRuleId(null);
                    setRuns([]);
                  }
                })
              }
            >
              {canConfigureProject
                ? translate("automation_rules.remove", "删除")
                : translate("automation_rules.remove_private", "删除本机规则")}
            </button>
          </div>
        ))}
      </div>
      {historyRuleId && (
        <div
          className="space-y-2 rounded-md border border-border p-3"
          data-testid="connection-rule-runs"
        >
          <h4 className="text-sm font-medium">
            {rules.find((rule) => rule.id === historyRuleId)?.name} ·{" "}
            {translate("automation_rules.history", "运行记录")}
          </h4>
          {runs.length === 0 && (
            <p className="text-sm text-text-secondary">
              {translate("automation_rules.no_runs", "暂无运行记录")}
            </p>
          )}
          {runs.map((run) => (
            <div className="flex items-center gap-2 text-xs" key={run.id}>
              <span>
                {new Date(run.createdAt).toLocaleString()} · {label(run.status)}
                {run.error
                  ? ` · ${translate("automation_rules.run_failed_hint", "未完成处理。请检查来源授权、执行配置或项目运行记录。")}`
                  : ""}
              </span>
              {run.issueId && onOpenIssue && (
                <button
                  type="button"
                  className="min-h-11 px-2 underline"
                  data-testid={`connection-rule-issue-${run.id}`}
                  onClick={() =>
                    void perform(async () => {
                      await onOpenIssue(run.issueId!);
                    })
                  }
                >
                  {translate("automation_rules.open_issue", "查看 Issue")}
                </button>
              )}
              {run.status === "failed" && run.retryable !== false && (
                <button
                  type="button"
                  disabled={busy || configurationDisabled}
                  className="min-h-11 px-2 underline"
                  data-testid={`connection-rule-retry-${run.id}`}
                  onClick={() =>
                    void perform(async (active) => {
                      await api.retry(run.id);
                      const items = await api.runs(historyRuleId!);
                      if (active()) setRuns(items);
                    })
                  }
                >
                  {translate("automation_rules.retry", "重试")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {draft && (
        <ConnectionRuleDialog
          label={translate("automation_rules.editor", "连接规则")}
          returnFocus={returnFocus}
        >
          <DialogForm
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !busy) setDraft(null);
            }}
            data-testid="connection-rule-editor"
            onSubmit={(event) => {
              event.preventDefault();
              if (configurationDisabled || busy || step !== "rule") return;
              void perform(async (active) => {
                await api.save(draft);
                onMutation?.();
                const items = await api.list(project);
                if (!active()) return;
                setRules(items);
                suspendedDrafts.current.clear();
                setDraft(null);
              });
            }}
          >
            <header className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-4">
              <button
                type="button"
                data-testid="connection-rule-back"
                disabled={busy}
                aria-label={translate("automation_rules.back", "返回")}
                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                onClick={() => {
                  if (step === "rule") setStep("connection");
                  else {
                    if (backToConnections.current && provider)
                      suspendedDrafts.current.set(provider.id, {
                        rule: draft,
                        resources,
                        query,
                        kind,
                      });
                    setDraft(null);
                    backToConnections.current?.();
                  }
                }}
              >
                <ArrowLeft aria-hidden="true" className="h-4 w-4" />
              </button>
              <div className="min-w-0 flex-1">
                <h2
                  className="truncate text-base font-medium"
                  title={
                    step === "rule" ? draft.source.name : provider?.displayName
                  }
                  data-testid="connection-rule-selected-source"
                >
                  {step === "rule"
                    ? draft.source.name
                    : (provider?.displayName ?? draft.source.name)}
                </h2>
                {step === "rule" && (
                  <p className="truncate text-xs text-text-secondary">
                    {provider?.displayName} ·{" "}
                    {translate(
                      "automation_rules.trigger_and_action",
                      "触发与动作",
                    )}
                  </p>
                )}
              </div>
              <button
                type="button"
                data-testid="connection-rule-close"
                disabled={busy}
                aria-label={translate("common.close", "关闭")}
                onClick={() => setDraft(null)}
                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </header>
            {error && (
              <div
                role="alert"
                className="px-5 pt-3 text-sm text-destructive"
                data-testid="connection-rule-error"
              >
                {error}
                <button
                  type="button"
                  className="min-h-11 px-2 underline"
                  data-testid="connection-rule-reload"
                  disabled={busy}
                  onClick={reloadRules}
                >
                  {translate(
                    "automation_rules.discard_reload",
                    "放弃未保存修改并重新加载",
                  )}
                </button>
              </div>
            )}
            {step === "connection" ? (
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
                <ConnectionSetupHeader
                  icon={connectionProviderIcon(provider?.id ?? "")}
                  title={translate(
                    "automation_rules.select_resource",
                    "选择连接",
                  )}
                  description={translate(
                    "automation_rules.select_connection_help",
                    "搜索并选择要监听的连接，原始内容和账号保持私有。",
                  )}
                />
                <ConnectionResourcePicker
                  kinds={(provider?.resourceKinds ?? []).map((id) => ({
                    id,
                    name: provider?.resourceLabels?.[id] ?? label(id),
                  }))}
                  kind={kind}
                  onKindChange={(value) => {
                    searchSequence.current += 1;
                    setKind(value);
                    setResources([]);
                    setDraft({
                      ...draft,
                      source: {
                        ...draft.source,
                        id: "",
                        profile: "",
                        name: "",
                        kind: value,
                      },
                    });
                  }}
                  query={query}
                  onQueryChange={(value) => {
                    searchSequence.current += 1;
                    setQuery(value);
                    setResources([]);
                  }}
                  onSearch={() =>
                    void perform(async (active) => {
                      const sequence = ++searchSequence.current;
                      const items = await api.resources(
                        provider!.id,
                        kind,
                        query,
                      );
                      if (active() && sequence === searchSequence.current)
                        setResources(items);
                    })
                  }
                  resources={selectableResources}
                  selected={
                    draft.source.id ? [connectionResourceKey(draft.source)] : []
                  }
                  onSelect={(source) => setDraft({ ...draft, source })}
                  translate={translate}
                  testId="connection-rule"
                  requireQuery={false}
                  disabled={configurationDisabled || !provider}
                  busy={busy}
                />
                {!provider && (
                  <p role="status">
                    {translate(
                      "automation_rules.no_providers",
                      "没有可用数据源，请先在个人分身中连接账号并完成授权。",
                    )}
                  </p>
                )}
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <fieldset
                  disabled={busy || configurationDisabled}
                  className="space-y-4"
                >
                  {!providers.some(
                    (item) => item.availability.status === "ready",
                  ) && (
                    <p role="status">
                      {translate(
                        "automation_rules.no_providers",
                        "没有可用数据源，请先在个人分身中连接账号并完成授权。",
                      )}
                    </p>
                  )}
                  <label className="block space-y-1 text-sm">
                    <span>
                      {translate("automation_rules.name", "规则名称")}
                    </span>
                    <input
                      className={fieldClass}
                      required
                      maxLength={100}
                      autoFocus
                      data-testid="connection-rule-name"
                      value={draft.name}
                      onChange={(event) =>
                        setDraft({ ...draft, name: event.target.value })
                      }
                    />
                  </label>
                  <label className="block space-y-1 text-sm">
                    <span>{translate("automation_rules.when", "当发生")}</span>
                    <select
                      className={fieldClass}
                      data-testid="connection-rule-event"
                      value={draft.eventType}
                      onChange={(event) =>
                        setDraft({ ...draft, eventType: event.target.value })
                      }
                    >
                      {provider?.eventTypes?.map((value) => (
                        <option key={value} value={value}>
                          {label(value)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <ConnectionRuleFields
                    sharedInstruction
                    testId="connection-rule-processing"
                    translate={translate}
                    value={draft}
                    onChange={(value) => setDraft({ ...draft, ...value })}
                  />
                  <fieldset className="space-y-2">
                    <legend className="mb-2 text-sm font-medium">
                      {translate(
                        "automation_rules.publish",
                        "执行：发布 Issue 并交给处理对象",
                      )}
                    </legend>
                    <RuleTargetPicker
                      value={{ kind: draft.targetKind, id: draft.targetId }}
                      options={{
                        human: targets.filter(
                          (target) => target.kind === "human",
                        ),
                        agent: targets.filter(
                          (target) => target.kind === "agent",
                        ),
                        collaboration_group: targets.filter(
                          (target) => target.kind === "collaboration_group",
                        ),
                      }}
                      onChange={(value) =>
                        setDraft({
                          ...draft,
                          targetKind: value.kind,
                          targetId: value.id,
                          runnerSelection: undefined,
                        })
                      }
                      translate={translate}
                      testId="connection-rule"
                    />
                    {draft.targetKind !== "human" &&
                      renderRunnerSelection?.(draft, (runnerSelection) =>
                        setDraft((current) =>
                          current ? { ...current, runnerSelection } : current,
                        ),
                      )}
                    <label className="block space-y-1 text-sm">
                      <span>
                        {translate(
                          "automation_rules.issue_title",
                          "发布的 Issue 标题",
                        )}
                      </span>
                      <input
                        className={fieldClass}
                        required
                        maxLength={255}
                        data-testid="connection-rule-title"
                        value={draft.publication.title}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            publication: {
                              ...draft.publication,
                              title: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <label className="block space-y-1 text-sm">
                      <span>
                        {translate(
                          "automation_rules.publication_instruction",
                          "发布要求（仅你可见）",
                        )}
                      </span>
                      <textarea
                        className={fieldClass}
                        required
                        rows={3}
                        aria-describedby="connection-publication-visibility"
                        data-testid="connection-rule-publication"
                        value={draft.publication.instruction}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            publication: {
                              ...draft.publication,
                              instruction: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <p
                      id="connection-publication-visibility"
                      className="text-xs text-text-secondary"
                    >
                      {translate(
                        "automation_rules.publication_visibility",
                        "按此要求生成的 Issue 内容将对项目成员可见。",
                      )}
                    </p>
                  </fieldset>
                </fieldset>
              </div>
            )}
            <div className="flex shrink-0 gap-2 border-t border-border px-5 py-3">
              {step === "connection" ? (
                <button
                  type="button"
                  data-testid="connection-rule-next"
                  className="collaboration-primary-button"
                  disabled={
                    busy ||
                    configurationDisabled ||
                    !draft.source.id ||
                    !provider
                  }
                  onClick={() => setStep("rule")}
                >
                  {translate("automation_rules.next", "下一步：触发与动作")}
                </button>
              ) : (
                <button
                  type="submit"
                  className="collaboration-primary-button min-h-11"
                  disabled={
                    busy ||
                    configurationDisabled ||
                    !draft.source.id ||
                    !draft.targetId ||
                    !draft.eventType
                  }
                  data-testid="connection-rule-save"
                >
                  {translate("automation_rules.save", "保存规则")}
                </button>
              )}
              <button
                type="button"
                className="min-h-11 px-3 text-sm"
                disabled={busy}
                data-testid="connection-rule-cancel"
                onClick={() => setDraft(null)}
              >
                {translate("automation_rules.cancel", "取消")}
              </button>
            </div>
          </DialogForm>
        </ConnectionRuleDialog>
      )}
    </section>
  );
}
