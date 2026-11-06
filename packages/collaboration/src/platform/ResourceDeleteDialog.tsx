// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import { platformMessages } from "./platformMessages";

export function ResourceDeleteDialog({
  name,
  kind,
  locale,
  onDelete,
  onClose,
}: {
  name: string;
  kind: "project" | "workspace";
  locale: "zh-CN" | "en";
  onDelete(): Promise<void>;
  onClose(): void;
}) {
  const messages = platformMessages[locale];
  const title =
    kind === "project"
      ? messages.deleteProjectTitle
      : messages.deleteWorkspaceTitle;
  const hint =
    kind === "project"
      ? messages.deleteProjectHint
      : messages.deleteWorkspaceHint;
  const confirm =
    kind === "project" ? messages.deleteProject : messages.deleteWorkspace;
  // Keep the existing project selectors used by desktop regressions.
  const testId =
    kind === "project"
      ? "collaboration-project-archive"
      : "collaboration-workspace-delete";
  const dialog = useRef<HTMLDivElement>(null);
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  const remove = async () => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      await onDelete();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : messages.deleteFailed);
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  return (
    <div
      className="collaboration-resource-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !lock.current) onClose();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-busy={pending}
        tabIndex={-1}
        data-testid={`${testId}-dialog`}
        className="w-full max-w-md rounded-2xl border border-border bg-background p-6 text-text-primary shadow-lg"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            if (!lock.current) onClose();
          }
          if (event.key !== "Tab") return;
          const buttons = Array.from(
            dialog.current?.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ) ?? [],
          );
          if (!buttons.length) {
            event.preventDefault();
            return;
          }
          const first = buttons[0],
            last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <h2 className="text-lg font-medium">{title}</h2>
        <p className="mt-3 break-words font-medium">{name}</p>
        <p className="mt-2 text-sm text-text-secondary">{hint}</p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            disabled={pending}
            className="min-h-11 rounded-lg px-4 text-sm hover:bg-muted disabled:opacity-50 md:min-h-8"
            data-testid={`${testId}-cancel`}
            onClick={onClose}
          >
            {messages.cancel}
          </button>
          <button
            type="button"
            disabled={pending}
            className="min-h-11 rounded-lg bg-destructive px-4 text-sm text-white disabled:opacity-50 md:min-h-8"
            data-testid={`${testId}-confirm`}
            onClick={() => void remove()}
          >
            {pending ? messages.deleting : confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
