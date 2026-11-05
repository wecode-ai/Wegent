import {
  ChevronRight,
  Mail,
  MessageSquare,
  Search,
  type LucideIcon,
} from "lucide-react";
import type { CollaborationTranslate } from "../i18n";
import type { AutomationConnectionResource } from "./connectionRules";

export function connectionProviderIcon(id: string): LucideIcon {
  return id === "@wegent/dsh-connection-runtime/email" ? Mail : MessageSquare;
}

export function ConnectionTypeRow({
  icon: Icon,
  label,
  disabled,
  testId,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  testId: string;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onSelect}
      className="flex min-h-11 md:min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted disabled:opacity-40"
    >
      <Icon
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-text-secondary"
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <ChevronRight
        aria-hidden="true"
        className="h-4 w-4 shrink-0 text-text-muted"
      />
    </button>
  );
}

export function ConnectionSetupHeader({
  icon: Icon,
  title,
  description,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  testId?: string;
}) {
  return (
    <header className="shrink-0 space-y-2" data-testid={testId}>
      <h3 className="flex items-center gap-2 text-base font-medium">
        <Icon aria-hidden="true" className="h-4 w-4" />
        {title}
      </h3>
      <p className="text-sm text-text-muted">{description}</p>
    </header>
  );
}

export const connectionResourceKey = (
  resource: Pick<AutomationConnectionResource, "profile" | "kind" | "id">,
) => JSON.stringify([resource.profile, resource.kind, resource.id]);

/** Controlled source selection; personal and project adapters keep their own authorization and storage. */
export function ConnectionResourcePicker<
  T extends Pick<
    AutomationConnectionResource,
    "profile" | "kind" | "id" | "name"
  >,
>({
  kinds,
  kind,
  onKindChange,
  query,
  onQueryChange,
  onSearch,
  resources,
  selected,
  connected = [],
  onSelect,
  translate,
  testId,
  disabled,
  busy,
  multiple = false,
  requireQuery = true,
}: {
  kinds: { id: string; name: string }[];
  kind: string;
  onKindChange(value: string): void;
  query: string;
  onQueryChange(value: string): void;
  onSearch(): void;
  resources: T[];
  selected: string[];
  connected?: string[];
  onSelect(resource: T): void;
  translate: CollaborationTranslate;
  testId: string;
  disabled?: boolean;
  busy?: boolean;
  multiple?: boolean;
  requireQuery?: boolean;
}) {
  return (
    <div className="space-y-3" data-testid={`${testId}-resource-picker`}>
      <div className="flex flex-wrap gap-2">
        {kinds.length > 1 && (
          <select
            aria-label={translate("automation_rules.resource_kind", "资源类型")}
            data-testid={`${testId}-kind`}
            value={kind}
            disabled={disabled || busy}
            onChange={(event) => onKindChange(event.target.value)}
            className="min-h-11 md:min-h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            {kinds.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        )}
        <input
          aria-label={translate("automation_rules.query", "搜索连接")}
          data-testid={`${testId}-query`}
          value={query}
          disabled={disabled}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (!disabled && !busy && (!requireQuery || query.trim()))
                onSearch();
            }
          }}
          className="min-h-11 md:min-h-9 min-w-0 flex-1 rounded-md border border-border bg-transparent px-3 text-sm"
          placeholder={translate(
            "automation_rules.query_placeholder",
            "搜索要连接的邮箱或群聊",
          )}
        />
        <button
          type="button"
          data-testid={`${testId}-search`}
          disabled={disabled || busy || (requireQuery && !query.trim())}
          onClick={onSearch}
          className="flex min-h-11 md:min-h-9 items-center gap-1 rounded-md border border-border px-3 text-sm disabled:opacity-50"
        >
          <Search aria-hidden="true" className="h-4 w-4" />
          {translate("automation_rules.search", "搜索")}
        </button>
      </div>
      <div
        className="max-h-52 overflow-y-auto"
        role={multiple ? "group" : "radiogroup"}
        aria-label={translate("automation_rules.resource", "选择连接")}
      >
        {resources.map((resource) => {
          const key = connectionResourceKey(resource);
          const alreadyConnected = connected.includes(key);
          const checked = alreadyConnected || selected.includes(key);
          return (
            <button
              key={key}
              type="button"
              role={multiple ? "checkbox" : "radio"}
              aria-checked={checked}
              data-testid={`${testId}-result-${resource.id}`}
              disabled={disabled || alreadyConnected}
              onClick={() => onSelect(resource)}
              className="flex min-h-11 md:min-h-9 w-full items-center justify-between gap-3 rounded-md px-2 text-left text-sm hover:bg-muted disabled:text-text-muted"
            >
              <span className="min-w-0 truncate">{resource.name}</span>
              <span className="shrink-0 text-text-muted">
                {translate(
                  alreadyConnected
                    ? "automation_rules.connected"
                    : checked
                      ? "automation_rules.selected"
                      : "automation_rules.select",
                  alreadyConnected ? "已连接" : checked ? "已选择" : "选择",
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
