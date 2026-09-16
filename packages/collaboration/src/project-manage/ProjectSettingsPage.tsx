// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

export function ProjectSettingsPage({
  actions,
  children,
  description,
  testId,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  description: string;
  testId: string;
  title: string;
}) {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-8 py-7 text-sm"
      data-testid={testId}
    >
      <div className="mx-auto max-w-3xl">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="heading-base tracking-normal text-text-primary">
              {title}
            </h1>
            <p className="mt-1 font-normal text-text-secondary">
              {description}
            </p>
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
