// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import type { CollaborationProject } from "../types";

const copy = {
  "zh-CN": {
    title: "归档项目？",
    hint: "归档后，项目将从协作列表中移除。此操作不会删除本地代码目录。",
    cancel: "取消",
    confirm: "归档项目",
    pending: "正在归档…",
    failed: "归档失败，请重试。",
  },
  en: {
    title: "Archive project?",
    hint: "The project will be removed from the collaboration list. Local code directories will not be deleted.",
    cancel: "Cancel",
    confirm: "Archive project",
    pending: "Archiving…",
    failed: "Could not archive the project. Please try again.",
  },
};

export function ProjectArchiveDialog({
  project,
  locale,
  onArchive,
  onClose,
}: {
  project: CollaborationProject;
  locale: "zh-CN" | "en";
  onArchive(): Promise<void>;
  onClose(): void;
}) {
  const messages = copy[locale];
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
  const archive = async () => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      await onArchive();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : messages.failed);
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
        aria-label={messages.title}
        aria-busy={pending}
        tabIndex={-1}
        data-testid="collaboration-project-archive-dialog"
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
        <h2 className="text-lg font-medium">{messages.title}</h2>
        <p className="mt-3 break-words font-medium">{project.name}</p>
        <p className="mt-2 text-sm text-text-secondary">{messages.hint}</p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            disabled={pending}
            className="min-h-11 rounded-lg px-4 text-sm hover:bg-muted disabled:opacity-50 md:min-h-8"
            data-testid="collaboration-project-archive-cancel"
            onClick={onClose}
          >
            {messages.cancel}
          </button>
          <button
            type="button"
            disabled={pending}
            className="min-h-11 rounded-lg bg-text-primary px-4 text-sm text-background disabled:opacity-50 md:min-h-8"
            data-testid="collaboration-project-archive-confirm"
            onClick={() => void archive()}
          >
            {pending ? messages.pending : messages.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
