// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { LoaderCircle, Plus, Search, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { ComposerPluginIcon } from "../composer/ComposerPluginIcon";
import { useOutsideClick } from "../composer/useOutsideClick";
import type { UnifiedAgentPluginRef } from "./types";

export interface AgentCapabilitySkill {
  displayName?: string;
  id: number;
  name: string;
  namespace?: string;
}

export interface AgentCapabilitiesLabels {
  add: string;
  loadingPlugins: string;
  loadingSkills: string;
  noneSelected: string;
  noPlugins: string;
  noSkills: string;
  plugins: string;
  pluginsUnavailable: string;
  remove: string;
  fromPrompt: string;
  sourceCloud: string;
  sourceLocal: string;
  sourceLocalCloud: string;
  searchPlugins: string;
  searchSkills: string;
  skills: string;
}

export function AgentCapabilitiesSelector({
  busy,
  collapsible = false,
  labels,
  loadingPlugins,
  loadingSkills,
  onPluginChange,
  onSkillChange,
  pluginError,
  plugins,
  pluginsEnabled = true,
  selectedPluginIds,
  selectedSkillKeys,
  requiredPluginIds = new Set<string>(),
  requiredSkillKeys = new Set<string>(),
  skillError,
  skillKey,
  skills,
  title,
  testIdPrefix,
}: {
  busy: boolean;
  collapsible?: boolean;
  labels: AgentCapabilitiesLabels;
  loadingPlugins: boolean;
  loadingSkills: boolean;
  onPluginChange(pluginId: string, selected: boolean): void;
  onSkillChange(skill: AgentCapabilitySkill, selected: boolean): void;
  pluginError?: string | null;
  plugins: UnifiedAgentPluginRef[];
  pluginsEnabled?: boolean;
  selectedPluginIds: ReadonlySet<string>;
  selectedSkillKeys: ReadonlySet<string>;
  requiredPluginIds?: ReadonlySet<string>;
  requiredSkillKeys?: ReadonlySet<string>;
  skillError?: string | null;
  skillKey(skill: AgentCapabilitySkill): string;
  skills: AgentCapabilitySkill[];
  title?: string;
  testIdPrefix: string;
}) {
  const selectedSkills = skills.filter((skill) =>
    selectedSkillKeys.has(skillKey(skill)),
  );
  const selectedPlugins = plugins.filter((plugin) =>
    selectedPluginIds.has(plugin.id),
  );

  const content = (
    <div
      className={
        collapsible
          ? "divide-y divide-border overflow-visible"
          : "divide-y divide-border overflow-visible rounded-xl border border-border"
      }
    >
      <CapabilityPicker
        addLabel={labels.add}
        busy={busy}
        disabled={!pluginsEnabled}
        disabledLabel={labels.pluginsUnavailable}
        emptyLabel={labels.noPlugins}
        error={pluginsEnabled ? pluginError : null}
        getKey={(plugin) => plugin.id}
        getLabel={(plugin) => plugin.displayName || plugin.pluginName}
        getMeta={(plugin) => plugin.marketplaceId}
        getDescription={(plugin) => plugin.description || plugin.marketplaceId}
        getIconLabel={(plugin) => plugin.displayName || plugin.pluginName}
        getSourceLabel={(plugin) =>
          plugin.catalogSource === "local"
            ? labels.sourceLocal
            : plugin.catalogSource === "cloud"
              ? labels.sourceCloud
              : plugin.catalogSource === "local_cloud"
                ? labels.sourceLocalCloud
                : ""
        }
        loading={pluginsEnabled && loadingPlugins}
        loadingLabel={labels.loadingPlugins}
        noneSelectedLabel={labels.noneSelected}
        onChange={(plugin, selected) => onPluginChange(plugin.id, selected)}
        options={plugins}
        removeLabel={labels.remove}
        searchPlaceholder={labels.searchPlugins}
        selected={selectedPlugins}
        requiredKeys={requiredPluginIds}
        requiredLabel={labels.fromPrompt}
        title={labels.plugins}
        testId={`${testIdPrefix}-plugins`}
        testOptionId={(plugin) => `${testIdPrefix}-plugin-${plugin.id}`}
      />

      <CapabilityPicker
        addLabel={labels.add}
        busy={busy}
        emptyLabel={labels.noSkills}
        error={skillError}
        getKey={skillKey}
        getLabel={(skill) => skill.displayName || skill.name}
        getMeta={(skill) => skill.namespace || "default"}
        loading={loadingSkills}
        loadingLabel={labels.loadingSkills}
        noneSelectedLabel={labels.noneSelected}
        onChange={onSkillChange}
        options={skills}
        removeLabel={labels.remove}
        searchPlaceholder={labels.searchSkills}
        selected={selectedSkills}
        requiredKeys={requiredSkillKeys}
        requiredLabel={labels.fromPrompt}
        title={labels.skills}
        testId={`${testIdPrefix}-skills`}
        testOptionId={(skill) => `${testIdPrefix}-skill-${skill.id}`}
      />
    </div>
  );

  if (!title) return content;

  if (collapsible) {
    return (
      <details
        className="group overflow-visible rounded-xl border border-border"
        data-testid={`${testIdPrefix}-capabilities-disclosure`}
      >
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-text-primary">
          {title}
        </summary>
        <div className="border-t border-border">{content}</div>
      </details>
    );
  }

  return (
    <section className="space-y-3">
      <SectionHeading>{title}</SectionHeading>
      {content}
    </section>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <h3 className="shrink-0 text-sm font-medium text-text-primary">
        {children}
      </h3>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function CapabilityPicker<T>({
  addLabel,
  busy,
  disabled = false,
  disabledLabel,
  emptyLabel,
  error,
  getKey,
  getLabel,
  getMeta,
  getDescription,
  getIconLabel,
  getSourceLabel,
  loading,
  loadingLabel,
  noneSelectedLabel,
  onChange,
  options,
  removeLabel,
  searchPlaceholder,
  selected,
  requiredKeys,
  requiredLabel,
  testId,
  testOptionId,
  title,
}: {
  addLabel: string;
  busy: boolean;
  disabled?: boolean;
  disabledLabel?: string;
  emptyLabel: string;
  error?: string | null;
  getKey(item: T): string;
  getLabel(item: T): string;
  getMeta(item: T): string;
  getDescription?(item: T): string;
  getIconLabel?(item: T): string;
  getSourceLabel?(item: T): string;
  loading: boolean;
  loadingLabel: string;
  noneSelectedLabel: string;
  onChange(item: T, selected: boolean): void;
  options: T[];
  removeLabel: string;
  searchPlaceholder: string;
  selected: T[];
  requiredKeys: ReadonlySet<string>;
  requiredLabel: string;
  testId: string;
  testOptionId(item: T): string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);
  useOutsideClick(rootRef, open, close);
  const selectedKeys = useMemo(
    () => new Set(selected.map((item) => getKey(item))),
    [getKey, selected],
  );
  const visibleOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((item) =>
      `${getLabel(item)} ${getMeta(item)} ${getDescription?.(item) ?? ""}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [getDescription, getLabel, getMeta, options, query]);

  return (
    <div
      className="min-w-0 px-3 py-2.5"
      data-testid={testId}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        close();
        rootRef.current
          ?.querySelector<HTMLButtonElement>(`[data-testid="${testId}-add"]`)
          ?.focus();
      }}
      ref={rootRef}
    >
      <div className="grid min-h-8 grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3">
        <span className="text-sm text-text-secondary">{title}</span>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {disabled ? (
            <span className="truncate text-sm text-text-muted">
              {disabledLabel}
            </span>
          ) : loading ? (
            <span className="flex items-center gap-2 text-sm text-text-muted">
              <LoaderCircle
                aria-hidden="true"
                className="h-3.5 w-3.5 animate-spin"
              />
              {loadingLabel}
            </span>
          ) : selected.length ? (
            selected.map((item) => (
              <span
                className="inline-flex h-7 max-w-full items-center gap-1 rounded-md bg-muted px-2 text-sm text-text-primary"
                key={getKey(item)}
              >
                <span className="truncate">{getLabel(item)}</span>
                {requiredKeys.has(getKey(item)) ? (
                  <span className="shrink-0 text-[11px] text-text-muted">
                    {requiredLabel}
                  </span>
                ) : (
                  <button
                    aria-label={`${removeLabel} ${getLabel(item)}`}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-text-muted hover:bg-background hover:text-text-primary"
                    disabled={busy}
                    onClick={() => onChange(item, false)}
                    type="button"
                  >
                    <X aria-hidden="true" className="h-3 w-3" />
                  </button>
                )}
              </span>
            ))
          ) : (
            <span className="text-sm text-text-muted">{noneSelectedLabel}</span>
          )}
        </div>
        <button
          className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:pointer-events-none disabled:opacity-40"
          data-testid={`${testId}-add`}
          disabled={busy || disabled || loading}
          aria-expanded={open}
          onClick={() => {
            if (open) close();
            else setOpen(true);
          }}
          type="button"
        >
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          {addLabel}
        </button>
      </div>

      {open && !disabled ? (
        <div
          className="mt-2 rounded-lg border border-border bg-popover p-2 shadow-lg"
          data-testid={`${testId}-picker`}
        >
          <label className="flex h-9 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-text-muted focus-within:border-focus focus-within:ring-2 focus-within:ring-focus/15">
            <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
            <input
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={searchPlaceholder}
              value={query}
            />
          </label>
          <div className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
            {visibleOptions.length ? (
              visibleOptions.map((item) => {
                const key = getKey(item);
                const checked = selectedKeys.has(key);
                return (
                  <label
                    className={[
                      "grid min-h-10 cursor-pointer items-center gap-2 rounded-lg px-2 transition-colors",
                      getIconLabel
                        ? "grid-cols-[22px_auto_minmax(0,1fr)_16px]"
                        : "grid-cols-[16px_minmax(0,1fr)_auto]",
                      checked ? "bg-muted" : "hover:bg-muted",
                    ].join(" ")}
                    key={key}
                    title={getDescription?.(item) || undefined}
                  >
                    {getIconLabel ? (
                      <ComposerPluginIcon
                        className="plugin-icon-slot h-[22px] w-[22px] rounded-md"
                        logo={{
                          contrastPad: false,
                          source: "fallback",
                          url: null,
                        }}
                        name={getIconLabel(item)}
                      />
                    ) : null}
                    <span className="min-w-0 truncate text-base leading-5 text-text-primary">
                      {getLabel(item)}
                    </span>
                    {getIconLabel ? (
                      <span className="min-w-0 truncate text-sm leading-5 text-text-muted">
                        {[getSourceLabel?.(item), getDescription?.(item)]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    ) : null}
                    <input
                      checked={checked}
                      className={[
                        "h-4 w-4 shrink-0 accent-current",
                        getIconLabel ? undefined : "order-first",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      data-testid={testOptionId(item)}
                      aria-label={
                        requiredKeys.has(key)
                          ? `${getLabel(item)} · ${requiredLabel}`
                          : undefined
                      }
                      disabled={busy || requiredKeys.has(key)}
                      onChange={(event) => onChange(item, event.target.checked)}
                      type="checkbox"
                    />
                    {!getIconLabel ? (
                      <span className="shrink-0 truncate text-xs text-text-muted">
                        {getMeta(item)}
                      </span>
                    ) : null}
                  </label>
                );
              })
            ) : (
              <div className="flex min-h-10 items-center px-2 text-sm text-text-muted">
                {emptyLabel}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {error ? (
        <div
          className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-500"
          data-testid={`${testId}-load-error`}
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
