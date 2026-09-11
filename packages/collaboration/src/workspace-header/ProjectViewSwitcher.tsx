// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode, Ref } from "react";

export type CollaborationProjectView =
  | "board"
  | "table"
  | "files"
  | "automation"
  | "manage";

export interface CollaborationProjectViewOption<
  View extends CollaborationProjectView = CollaborationProjectView,
> {
  id: View;
  label: string;
  testId: string;
}

interface ProjectViewSwitcherProps<View extends CollaborationProjectView> {
  ariaLabel?: string;
  compact: boolean;
  options: CollaborationProjectViewOption<View>[];
  value: View;
  compactIcon?: ReactNode;
  containerRef?: Ref<HTMLElement>;
  onChange(view: View): void;
}

export function ProjectViewSwitcher<View extends CollaborationProjectView>({
  ariaLabel,
  compact,
  compactIcon,
  containerRef,
  onChange,
  options,
  value,
}: ProjectViewSwitcherProps<View>) {
  if (compact) {
    return (
      <span
        ref={containerRef}
        className="electron-titlebar-interactive-region relative z-10 ml-2 inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-border bg-background px-2.5 text-xs text-text-secondary"
      >
        <select
          aria-label={ariaLabel ?? "视图切换"}
          value={value}
          onChange={(event) => onChange(event.target.value as View)}
          className="h-8 cursor-pointer bg-transparent text-xs outline-none"
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {compactIcon}
      </span>
    );
  }

  return (
    <nav
      ref={containerRef}
      aria-label={ariaLabel}
      className="electron-titlebar-interactive-region relative z-10 ml-8 flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {options.map((option) => (
        <button
          type="button"
          data-testid={option.testId}
          key={option.id}
          aria-current={value === option.id ? "page" : undefined}
          onClick={() => onChange(option.id)}
          className={
            value === option.id
              ? "rounded-md bg-background px-3.5 py-1 text-sm font-medium text-text-primary shadow-sm"
              : "rounded-md px-3.5 py-1 text-sm text-text-secondary hover:text-text-primary"
          }
        >
          {option.label}
        </button>
      ))}
    </nav>
  );
}
