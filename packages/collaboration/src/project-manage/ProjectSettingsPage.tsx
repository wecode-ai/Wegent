// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

export const projectSettingsPageClassName = "min-h-0 flex-1 px-5 py-6 text-sm";
export const projectSettingsContentClassName = "mx-auto max-w-4xl";

export function ProjectSettingsPage({
  actions,
  children,
  contentWidth = "default",
  description,
  testId,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  contentWidth?: "default" | "wide";
  description: string;
  testId: string;
  title: string;
}) {
  return (
    <div className={projectSettingsPageClassName} data-testid={testId}>
      <div
        className={
          contentWidth === "wide"
            ? "mx-auto max-w-5xl"
            : projectSettingsContentClassName
        }
      >
        <header className="mb-6 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="heading-base tracking-normal text-text-primary">
              {title}
            </h1>
            <p className="mt-1 text-sm text-text-secondary">{description}</p>
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          ) : null}
        </header>
        {children}
      </div>
    </div>
  );
}
