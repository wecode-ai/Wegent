import {
  Check,
  Copy,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AutomationEventCollectionMode,
  AutomationEventSourceCatalogItem,
  AutomationEventSourceType,
} from "../automation";
import type {
  AutomationIncomingHook,
  AutomationIncomingHookUiApi,
} from "./AutomationRulesView.jsx";
import { PopupMenu, Tooltip, useTranslation } from "./AutomationUiHost";
import { automationClass } from "./automationStyles";

type IncomingHookApi = AutomationIncomingHookUiApi;
type ProjectEventCollectionMode = AutomationEventCollectionMode;
type ProjectEventSourceCatalogItem = AutomationEventSourceCatalogItem;
type ProjectEventSourceType = AutomationEventSourceType;
type ProjectIncomingHook = AutomationIncomingHook;

function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

interface SubscriptionDraft {
  name: string;
  sourceType: ProjectEventSourceType;
  resourceUrl: string;
}

function sourceName(sourceType: ProjectEventSourceType): string {
  if (sourceType === "github") return "GitHub";
  if (sourceType === "gitlab") return "GitLab";
  if (sourceType === "wework") return "Wework";
  return "Generic";
}

function subscriptionResourceLabel(subscription: ProjectIncomingHook): string {
  return (
    subscription.resource.displayName ||
    subscription.resource.path ||
    subscription.resource.url ||
    subscription.resource.externalId ||
    subscription.name
  );
}

function availableWebhookSources(
  catalog: ProjectEventSourceCatalogItem[],
  sourceTypes?: ProjectEventSourceType[],
): ProjectEventSourceCatalogItem[] {
  const allowed = new Set(sourceTypes ?? []);
  return catalog.filter(
    (source) =>
      source.sourceType !== "wework" &&
      source.sourceType !== "generic" &&
      source.collectionModes.includes("webhook") &&
      (!allowed.size || allowed.has(source.sourceType)),
  );
}

function emptyDraft(
  sources: ProjectEventSourceCatalogItem[],
): SubscriptionDraft {
  return {
    name: "",
    sourceType: sources[0]?.sourceType ?? "github",
    resourceUrl: "",
  };
}

export function EventSubscriptionPicker({
  api,
  projectId,
  catalog = [],
  sourceTypes,
  collectionMode,
  cascadeIndex,
  testIdPrefix = "automation",
  canManage = true,
  value,
  onChange,
}: {
  api?: IncomingHookApi;
  projectId?: string;
  catalog?: ProjectEventSourceCatalogItem[];
  sourceTypes?: ProjectEventSourceType[];
  collectionMode: ProjectEventCollectionMode;
  cascadeIndex: number;
  testIdPrefix?: string;
  canManage?: boolean;
  value: string | null;
  onChange: (subscriptionId: string | null) => void;
}) {
  const { t } = useTranslation("common");
  const [subscriptions, setSubscriptions] = useState<ProjectIncomingHook[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const managerRef = useRef<HTMLDivElement | null>(null);
  const onChangeRef = useRef(onChange);
  const valueRef = useRef(value);
  const loadSequenceRef = useRef(0);
  const sourceKey = [...(sourceTypes ?? [])].sort().join(",");
  const testId =
    testIdPrefix === "automation"
      ? "automation-event-subscription"
      : `${testIdPrefix}-event-subscription`;

  useEffect(() => {
    onChangeRef.current = onChange;
    valueRef.current = value;
  });

  const load = useCallback(async () => {
    if (!api || !projectId) return;
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    setError(null);
    try {
      const allowedSources = new Set(sourceKey ? sourceKey.split(",") : []);
      const list = (await api.list(projectId)).filter(
        (item) =>
          item.collectionMode === collectionMode &&
          (!allowedSources.size || allowedSources.has(item.sourceType)),
      );
      if (sequence !== loadSequenceRef.current) return;
      setSubscriptions(list);
      const selectable = list.filter((item) => item.status === "active");
      if (!selectable.some((item) => item.id === valueRef.current)) {
        const next = selectable[0]?.id ?? null;
        if (next !== valueRef.current) onChangeRef.current(next);
      }
    } catch (cause) {
      if (sequence !== loadSequenceRef.current) return;
      setError(
        cause instanceof Error
          ? cause.message
          : t("todo.event_subscription_load_failed"),
      );
    } finally {
      if (sequence === loadSequenceRef.current) setLoading(false);
    }
  }, [api, collectionMode, projectId, sourceKey, t]);

  useEffect(() => {
    queueMicrotask(() => void load());
    return () => {
      loadSequenceRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!managerOpen) return;
    const frame = window.requestAnimationFrame(() => {
      managerRef.current?.scrollIntoView?.({
        block: "nearest",
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [managerOpen]);

  const selectableSubscriptions = subscriptions.filter(
    (item) => item.status === "active",
  );
  const selected = subscriptions.find((item) => item.id === value) ?? null;
  const showManager = collectionMode === "webhook" && canManage;
  const isWebhook = collectionMode === "webhook";
  const fieldLabel = isWebhook
    ? t("todo.automation_event_subscription")
    : t("todo.automation_polling_resource");
  const emptyLabel = isWebhook
    ? t("todo.automation_event_subscription_none")
    : t("todo.automation_polling_resource_none");

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2">
      <label className={automationClass("panel-field")}>
        <span>
          <i className={automationClass("cascade-index")}>{cascadeIndex}</i>
          {fieldLabel}
        </span>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
          <select
            className="min-w-0 flex-1"
            data-testid={testId}
            value={value ?? ""}
            disabled={loading || selectableSubscriptions.length === 0}
            onChange={(event) => onChange(event.target.value || null)}
          >
            {selectableSubscriptions.length === 0 ? (
              <option value="">{emptyLabel}</option>
            ) : (
              selectableSubscriptions.map((subscription) => (
                <option key={subscription.id} value={subscription.id}>
                  {subscription.name} ·{" "}
                  {subscriptionResourceLabel(subscription)}
                </option>
              ))
            )}
          </select>
          {showManager ? (
            <button
              type="button"
              data-testid={`${testIdPrefix}-manage-event-subscriptions`}
              className={cn(
                automationClass("project-secondary-action"),
                "shrink-0 whitespace-nowrap px-3",
              )}
              aria-expanded={managerOpen}
              onClick={() => setManagerOpen((current) => !current)}
            >
              {managerOpen ? (
                <X className="h-4 w-4" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {managerOpen
                ? t("todo.automation_event_subscription_done")
                : t("todo.automation_event_subscription_manage")}
            </button>
          ) : null}
        </div>
      </label>

      {selected ? (
        <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-text-secondary">
          <Webhook className="h-4 w-4 shrink-0 text-text-muted" />
          <span className="min-w-0 flex-1 truncate">
            {subscriptionResourceLabel(selected)}
          </span>
          <span className="shrink-0 text-text-muted">
            {sourceName(selected.sourceType)}
          </span>
        </div>
      ) : (
        <p className={automationClass("execution-hint")}>
          {isWebhook
            ? t("todo.automation_event_subscription_manage_hint")
            : t("todo.automation_polling_resource_hint")}
        </p>
      )}

      {managerOpen ? (
        <div
          ref={managerRef}
          className="grid min-w-0 grid-cols-[minmax(0,1fr)]"
        >
          <EventSubscriptionManager
            api={api}
            projectId={projectId}
            catalog={catalog}
            sourceTypes={sourceTypes}
            canManage={canManage}
            subscriptions={subscriptions}
            selectedId={value}
            onSubscriptionsChange={setSubscriptions}
            onSelect={onChange}
          />
        </div>
      ) : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

function EventSubscriptionManager({
  api,
  projectId,
  catalog,
  sourceTypes,
  canManage,
  subscriptions,
  selectedId,
  onSubscriptionsChange,
  onSelect,
}: {
  api?: IncomingHookApi;
  projectId?: string;
  catalog: ProjectEventSourceCatalogItem[];
  sourceTypes?: ProjectEventSourceType[];
  canManage: boolean;
  subscriptions: ProjectIncomingHook[];
  selectedId: string | null;
  onSubscriptionsChange: (subscriptions: ProjectIncomingHook[]) => void;
  onSelect: (subscriptionId: string | null) => void;
}) {
  const { t } = useTranslation("common");
  const sources = useMemo(
    () => availableWebhookSources(catalog, sourceTypes),
    [catalog, sourceTypes],
  );
  const [draft, setDraft] = useState<SubscriptionDraft>(() =>
    emptyDraft(sources),
  );
  const [editorOpen, setEditorOpen] = useState(subscriptions.length === 0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const draftSourceType = sources.some(
    (source) => source.sourceType === draft.sourceType,
  )
    ? draft.sourceType
    : (sources[0]?.sourceType ?? draft.sourceType);

  async function createSubscription() {
    if (!api || !projectId || busyId || !draft.resourceUrl.trim()) return;
    setBusyId("create");
    setError(null);
    try {
      const subscription = await api.create(projectId, {
        name:
          draft.name.trim() || `${sourceName(draftSourceType)} subscription`,
        sourceType: draftSourceType,
        collectionMode: "webhook",
        resource: { url: draft.resourceUrl.trim() },
        pollIntervalSeconds: null,
        credentialRef: null,
      });
      onSubscriptionsChange([...subscriptions, subscription]);
      onSelect(subscription.id);
      setDraft(emptyDraft(sources));
      setEditorOpen(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("todo.event_subscription_create_failed"),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function updateStatus(subscription: ProjectIncomingHook) {
    if (!api || !projectId || busyId) return;
    setBusyId(subscription.id);
    setError(null);
    try {
      const updated = await api.update(projectId, subscription.id, {
        version: subscription.version,
        status: subscription.status === "active" ? "disabled" : "active",
      });
      const next = subscriptions.map((item) =>
        item.id === updated.id ? updated : item,
      );
      onSubscriptionsChange(next);
      if (updated.status === "disabled" && selectedId === updated.id) {
        onSelect(next.find((item) => item.status === "active")?.id ?? null);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("todo.event_subscription_update_failed"),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function removeSubscription(subscription: ProjectIncomingHook) {
    if (
      !api ||
      !projectId ||
      busyId ||
      !window.confirm(
        t("todo.event_subscription_delete_confirm", {
          name: subscription.name,
        }),
      )
    ) {
      return;
    }
    setBusyId(subscription.id);
    setError(null);
    try {
      await api.remove(projectId, subscription.id);
      const next = subscriptions.filter((item) => item.id !== subscription.id);
      onSubscriptionsChange(next);
      if (selectedId === subscription.id) {
        onSelect(next.find((item) => item.status === "active")?.id ?? null);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("todo.event_subscription_delete_failed"),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function rotateSubscription(subscription: ProjectIncomingHook) {
    if (
      !api ||
      !projectId ||
      busyId ||
      !window.confirm(t("todo.event_subscription_rotate_confirm"))
    ) {
      return;
    }
    setBusyId(subscription.id);
    setError(null);
    try {
      const updated = await api.rotate(projectId, subscription.id);
      onSubscriptionsChange(
        subscriptions.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("todo.event_subscription_rotate_failed"),
      );
    } finally {
      setBusyId(null);
    }
  }

  async function copyValue(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedValue(value);
      window.setTimeout(
        () => setCopiedValue((current) => (current === value ? null : current)),
        1500,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("todo.event_subscription_copy_failed"),
      );
    }
  }

  if (!api || !projectId) {
    return (
      <p className={automationClass("panel-help")}>
        {t("todo.event_subscription_unavailable")}
      </p>
    );
  }

  return (
    <section
      className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-xl border border-border bg-muted/20 p-3"
      data-testid="event-subscription-manager"
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <div className="min-w-0">
          <strong className="text-sm font-medium">
            {t("todo.event_subscription_title")}
          </strong>
          <p className="mt-0.5 truncate text-xs text-text-muted">
            {t("todo.automation_event_subscription_inline_hint")}
          </p>
        </div>
        <button
          type="button"
          data-testid="event-subscription-add"
          disabled={!canManage || busyId !== null || sources.length === 0}
          onClick={() => setEditorOpen(true)}
          className={cn(
            automationClass("project-secondary-action"),
            "shrink-0 whitespace-nowrap px-3",
          )}
        >
          <Plus className="h-4 w-4" />
          {t("todo.event_subscription_add")}
        </button>
      </div>

      {editorOpen ? (
        <div
          className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 rounded-lg border border-border bg-background p-3"
          data-testid="event-subscription-editor"
        >
          <div className="flex items-center justify-between gap-3">
            <strong className="text-sm font-medium">
              {t("todo.event_subscription_create")}
            </strong>
            <button
              type="button"
              data-testid="event-subscription-cancel"
              onClick={() => setEditorOpen(false)}
              className="grid size-7 place-items-center rounded-lg text-text-muted hover:bg-muted"
              aria-label={t("common.cancel")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
            {sources.length > 1 ? (
              <label className={automationClass("panel-field")}>
                <span>{t("todo.event_subscription_source_type")}</span>
                <select
                  data-testid="event-subscription-source-type"
                  value={draftSourceType}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      sourceType: event.target.value as ProjectEventSourceType,
                    }))
                  }
                >
                  {sources.map((source) => (
                    <option key={source.sourceType} value={source.sourceType}>
                      {sourceName(source.sourceType)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className={automationClass("panel-field")}>
              <span>{t("todo.event_subscription_name")}</span>
              <input
                data-testid="event-subscription-name"
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
            </label>
            <label className={automationClass("panel-field")}>
              <span>{t("todo.event_subscription_resource_url")}</span>
              <input
                data-testid="event-subscription-resource-url"
                value={draft.resourceUrl}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    resourceUrl: event.target.value,
                  }))
                }
                placeholder={
                  draftSourceType === "gitlab"
                    ? "https://gitlab.com/group/project"
                    : "https://github.com/owner/repository"
                }
              />
            </label>
          </div>
          <div className="flex min-w-0 justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditorOpen(false)}
              className={cn(
                automationClass("project-secondary-action"),
                "shrink-0 whitespace-nowrap",
              )}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              data-testid="event-subscription-save"
              disabled={busyId !== null || !draft.resourceUrl.trim()}
              onClick={() => void createSubscription()}
              className={cn(
                automationClass("project-primary-action"),
                "shrink-0 whitespace-nowrap",
              )}
            >
              {t("todo.event_subscription_save")}
            </button>
          </div>
        </div>
      ) : null}

      {subscriptions.length ? (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1">
          {subscriptions.map((subscription) => {
            const selected = subscription.id === selectedId;
            return (
              <div
                key={subscription.id}
                data-testid={`event-subscription-card-${subscription.id}`}
                className={cn(
                  "min-w-0 rounded-lg px-2 py-2",
                  selected
                    ? "bg-background ring-1 ring-border"
                    : "hover:bg-background/70",
                )}
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid={`event-subscription-select-${subscription.id}`}
                    disabled={subscription.status !== "active"}
                    onClick={() => onSelect(subscription.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-50"
                  >
                    <span
                      className={cn(
                        "grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-text-muted",
                        selected && "text-text-primary",
                      )}
                    >
                      {selected ? (
                        <Check className="h-4 w-4" />
                      ) : (
                        <Webhook className="h-4 w-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm font-medium">
                        {subscription.name}
                      </strong>
                      <small className="block truncate text-xs text-text-muted">
                        {sourceName(subscription.sourceType)} ·{" "}
                        {subscriptionResourceLabel(subscription)}
                      </small>
                    </span>
                    <span className="shrink-0 text-xs text-text-muted">
                      {subscription.status === "active"
                        ? t("todo.event_subscription_status_active")
                        : t("todo.event_subscription_status_disabled")}
                    </span>
                  </button>
                  <PopupMenu
                    testId={`event-subscription-actions-${subscription.id}`}
                    menuWidth={168}
                    triggerClassName="grid size-7 place-items-center rounded-lg text-text-muted hover:bg-muted"
                    ariaLabel={t("todo.event_subscription_actions")}
                    trigger={<MoreHorizontal className="h-4 w-4" />}
                  >
                    {(close: () => void) => (
                      <>
                        <button
                          type="button"
                          data-testid={`event-subscription-toggle-${subscription.id}`}
                          onClick={() => {
                            close();
                            void updateStatus(subscription);
                          }}
                          className={automationClass("card-menu-action")}
                        >
                          {subscription.status === "active"
                            ? t("todo.event_subscription_disable")
                            : t("todo.event_subscription_enable")}
                        </button>
                        <button
                          type="button"
                          data-testid={`event-subscription-rotate-${subscription.id}`}
                          onClick={() => {
                            close();
                            void rotateSubscription(subscription);
                          }}
                          className={automationClass("card-menu-action")}
                        >
                          <RefreshCw className="h-4 w-4" />
                          {t("todo.event_subscription_rotate_short")}
                        </button>
                        <button
                          type="button"
                          data-testid={`event-subscription-delete-${subscription.id}`}
                          onClick={() => {
                            close();
                            void removeSubscription(subscription);
                          }}
                          className={automationClass("card-menu-action danger")}
                        >
                          <Trash2 className="h-4 w-4" />
                          {t("common.delete")}
                        </button>
                      </>
                    )}
                  </PopupMenu>
                </div>

                {selected && subscription.webhookUrl ? (
                  <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 border-t border-border pt-2">
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
                      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-0.5">
                        <span className="text-xs text-text-muted">
                          {t("todo.automation_event_subscription_webhook_url")}
                        </span>
                        <code className="block min-w-0 truncate text-code text-text-secondary">
                          {subscription.webhookUrl}
                        </code>
                      </div>
                      <Tooltip label={t("todo.event_subscription_copy_url")}>
                        <button
                          type="button"
                          data-testid={`event-subscription-copy-url-${subscription.id}`}
                          onClick={() =>
                            void copyValue(subscription.webhookUrl!)
                          }
                          className="grid size-7 shrink-0 place-items-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary"
                          aria-label={t("todo.event_subscription_copy_url")}
                        >
                          {copiedValue === subscription.webhookUrl ? (
                            <Check className="h-4 w-4" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : editorOpen ? null : (
        <button
          type="button"
          data-testid="event-subscription-empty-add"
          onClick={() => setEditorOpen(true)}
          className="flex min-h-20 items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-text-secondary hover:bg-background hover:text-text-primary"
        >
          <Plus className="h-4 w-4" />
          {t("todo.event_subscription_create")}
        </button>
      )}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}
