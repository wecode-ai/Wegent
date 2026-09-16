// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

function classes(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function StandardFormGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={classes("space-y-4", className)}>{children}</div>;
}

export function StandardFormRow({
  align = "center",
  children,
  className,
  description,
  label,
}: {
  align?: "start" | "center";
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  label: ReactNode;
}) {
  return (
    <div
      className={classes(
        "grid gap-2 md:grid-cols-[minmax(150px,190px)_minmax(0,1fr)] md:gap-5",
        className,
      )}
    >
      <div className="space-y-1">
        <label className="text-sm font-medium text-text-primary">{label}</label>
        {description ? (
          <p className="text-xs leading-5 text-text-muted">{description}</p>
        ) : null}
      </div>
      <div
        className={classes(
          "min-w-0",
          align === "center" ? "md:self-center" : "md:self-start",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function StandardFormSection({
  children,
  collapsible = true,
  defaultExpanded = true,
  testId,
  title,
}: {
  children: ReactNode;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  testId?: string;
  title: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const contentId = useId();
  const heading = (
    <>
      <h3 className="shrink-0 text-sm font-semibold text-text-primary">
        {title}
      </h3>
      <div className="h-px flex-1 bg-border transition-colors group-hover:bg-primary/40" />
      {collapsible ? (
        <ChevronDown
          aria-hidden="true"
          className={classes(
            "h-4 w-4 shrink-0 text-text-muted transition-transform duration-200",
            expanded ? undefined : "-rotate-90",
          )}
        />
      ) : null}
    </>
  );

  return (
    <section className="space-y-4">
      {collapsible ? (
        <button
          aria-controls={contentId}
          aria-expanded={expanded}
          className="group flex w-full items-center gap-3 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          data-testid={testId ? `${testId}-trigger` : undefined}
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {heading}
        </button>
      ) : (
        <div className="flex items-center gap-3">{heading}</div>
      )}
      {expanded ? (
        <div
          data-testid={testId ? `${testId}-content` : undefined}
          id={contentId}
        >
          {children}
        </div>
      ) : null}
    </section>
  );
}
