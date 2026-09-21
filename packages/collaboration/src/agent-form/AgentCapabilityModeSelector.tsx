// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Blocks, Check, Laptop, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

import type { UnifiedAgentCapabilityMode } from "./types";

export interface AgentCapabilityModeLabels {
  devicePreviewHint: string;
  devicePreviewTitle: string;
  devicePreviewUnavailable: string;
  followDescription: string;
  followTitle: string;
  loadingCapabilities: string;
  manualDescription: string;
  manualReady: string;
  manualTitle: string;
  title: string;
}

export function AgentCapabilityModeSelector({
  busy,
  capabilityItems = [],
  capabilitySummary,
  currentDevice,
  labels,
  loadingCapabilities = false,
  onChange,
  testIdPrefix,
  value,
}: {
  busy: boolean;
  capabilityItems?: string[];
  capabilitySummary?: string;
  currentDevice?: { id: string; name: string } | null;
  labels: AgentCapabilityModeLabels;
  loadingCapabilities?: boolean;
  onChange(value: UnifiedAgentCapabilityMode): void;
  testIdPrefix: string;
  value: UnifiedAgentCapabilityMode;
}) {
  return (
    <section className="space-y-3">
      <SectionHeading>{labels.title}</SectionHeading>
      <div className="grid gap-3 md:grid-cols-2">
        <ModeCard
          checked={value === "follow_device"}
          description={labels.followDescription}
          disabled={busy}
          groupName={`${testIdPrefix}-capability-mode`}
          icon={<Laptop aria-hidden="true" className="h-4 w-4" />}
          onSelect={() => onChange("follow_device")}
          testId={`${testIdPrefix}-capability-mode-follow`}
          title={labels.followTitle}
        />
        <ModeCard
          checked={value === "manual"}
          description={labels.manualDescription}
          disabled={busy}
          groupName={`${testIdPrefix}-capability-mode`}
          icon={<Blocks aria-hidden="true" className="h-4 w-4" />}
          onSelect={() => onChange("manual")}
          testId={`${testIdPrefix}-capability-mode-manual`}
          title={labels.manualTitle}
        />
      </div>

      {value === "follow_device" ? (
        <div
          className="rounded-xl bg-surface px-4 py-3"
          data-testid={`${testIdPrefix}-device-capability-preview`}
        >
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background text-text-secondary">
              {loadingCapabilities ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin"
                />
              ) : (
                <Laptop aria-hidden="true" className="h-4 w-4" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-text-primary">
                  {labels.devicePreviewTitle}
                </span>
                <span className="truncate text-xs text-text-muted">
                  {currentDevice?.name || labels.devicePreviewUnavailable}
                </span>
              </span>
              {loadingCapabilities ? (
                <span className="mt-1 block text-xs text-text-muted">
                  {labels.loadingCapabilities}
                </span>
              ) : capabilityItems.length ? (
                <span className="mt-2 flex flex-wrap gap-1.5">
                  {capabilityItems.map((item) => (
                    <span
                      className="rounded-md border border-border bg-background px-2 py-1 text-xs text-text-secondary"
                      key={item}
                    >
                      {item}
                    </span>
                  ))}
                </span>
              ) : capabilitySummary ? (
                <span className="mt-1 block text-xs text-text-secondary">
                  {capabilitySummary}
                </span>
              ) : null}
              <span className="mt-2 block text-xs leading-5 text-text-muted">
                {labels.devicePreviewHint}
              </span>
            </span>
          </div>
        </div>
      ) : (
        <div
          className="flex items-center gap-2 rounded-xl bg-surface px-4 py-3 text-xs leading-5 text-text-secondary"
          data-testid={`${testIdPrefix}-manual-capability-summary`}
        >
          <Check aria-hidden="true" className="h-3.5 w-3.5" />
          {labels.manualReady}
        </div>
      )}
    </section>
  );
}

function ModeCard({
  checked,
  description,
  disabled,
  groupName,
  icon,
  onSelect,
  testId,
  title,
}: {
  checked: boolean;
  description: string;
  disabled: boolean;
  groupName: string;
  icon: ReactNode;
  onSelect(): void;
  testId: string;
  title: string;
}) {
  return (
    <label
      className={[
        "flex min-h-28 cursor-pointer items-start gap-3 rounded-xl border px-4 py-3.5 transition-[border-color,background-color,box-shadow]",
        checked
          ? "border-focus bg-focus/5 ring-1 ring-focus/15"
          : "border-border bg-background hover:bg-muted/40",
        disabled ? "pointer-events-none opacity-50" : undefined,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <input
        checked={checked}
        className="mt-1 h-4 w-4 accent-current"
        data-testid={testId}
        disabled={disabled}
        name={groupName}
        onChange={onSelect}
        type="radio"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <span className="text-text-secondary">{icon}</span>
          {title}
        </span>
        <span className="mt-1.5 block text-xs leading-5 text-text-secondary">
          {description}
        </span>
      </span>
    </label>
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
