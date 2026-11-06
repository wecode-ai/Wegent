// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  WorkspaceRecycleBinApi,
  WorkspaceRecycleBinItem,
} from "../ports/SharedWorkspaceApi";
import { platformMessages } from "./platformMessages";

const actionClass =
  "min-h-11 rounded-lg px-3 text-sm hover:bg-muted disabled:opacity-50 md:min-h-8";

export function DeletedResourceNotice({
  item,
  locale,
  onRestore,
  onDismiss,
}: {
  item: WorkspaceRecycleBinItem;
  locale: "zh-CN" | "en";
  onRestore(item: WorkspaceRecycleBinItem): Promise<void>;
  onDismiss(): void;
}) {
  const messages = platformMessages[locale];
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2 text-sm"
      role="status"
    >
      <span className="min-w-0 break-words">
        {messages.deletedToRecycleBin}：{item.name}
      </span>
      <button
        type="button"
        className={actionClass}
        disabled={pending}
        data-testid={`collaboration-undo-delete-${item.kind}-${item.id}`}
        onClick={async () => {
          if (lock.current) return;
          lock.current = true;
          setPending(true);
          setError(null);
          try {
            await onRestore(item);
            onDismiss();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            lock.current = false;
            setPending(false);
          }
        }}
      >
        {pending ? messages.restoring : messages.undoDelete}
      </button>
      <button
        type="button"
        className={actionClass}
        disabled={pending}
        data-testid={`collaboration-dismiss-delete-${item.kind}-${item.id}`}
        onClick={onDismiss}
      >
        {messages.close}
      </button>
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

export function RecycleBinPage({
  api,
  locale,
  onRestore,
}: {
  api: WorkspaceRecycleBinApi;
  locale: "zh-CN" | "en";
  onRestore(item: WorkspaceRecycleBinItem): Promise<void>;
}) {
  const messages = platformMessages[locale];
  const revision = useRef(0);
  const lock = useRef(false);
  const [items, setItems] = useState<WorkspaceRecycleBinItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const request = ++revision.current;
    setLoading(true);
    setError(null);
    try {
      const result = await api.list();
      if (request === revision.current) {
        setItems(result.items);
        setError(result.errors.length ? result.errors.join(" · ") : null);
      }
    } catch (cause) {
      if (request === revision.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    setItems([]);
    void load();
    return () => {
      revision.current += 1;
    };
  }, [load]);
  return (
    <section
      className="collaboration-platform-panel"
      data-testid="collaboration-recycle-bin-page"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2>{messages.recycleBin}</h2>
        <button
          type="button"
          className={actionClass}
          disabled={loading || !!restoring}
          data-testid="collaboration-recycle-bin-refresh"
          onClick={() => void load()}
        >
          {messages.refresh}
        </button>
      </header>
      <p className="mt-2 text-sm text-text-secondary">
        {messages.recycleBinHint}
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {loading && (
        <p role="status" className="mt-4 text-sm text-text-secondary">
          {messages.loading}
        </p>
      )}
      {!loading && !error && !items.length && (
        <p className="mt-6 text-sm text-text-secondary">
          {messages.recycleBinEmpty}
        </p>
      )}
      <ul className="mt-4">
        {items.map((item) => {
          const key = `${item.kind}-${item.id}`;
          return (
            <li
              key={key}
              className="flex flex-wrap items-center gap-3 border-b border-border py-3"
              data-testid={`collaboration-recycle-bin-item-${key}`}
            >
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm">{item.name}</p>
                <p className="text-xs text-text-secondary">
                  {item.kind === "workspace"
                    ? messages.spaces
                    : messages.projects}
                  {item.workspaceName ? ` · ${item.workspaceName}` : ""}
                  {item.deletedAt
                    ? ` · ${new Date(item.deletedAt).toLocaleString(locale)}`
                    : ""}
                </p>
                {item.parentDeleted && (
                  <p className="text-xs text-text-secondary">
                    {messages.restoreParentFirst}
                  </p>
                )}
              </div>
              <button
                type="button"
                className={actionClass}
                disabled={!!restoring || loading || item.parentDeleted}
                data-testid={`collaboration-recycle-bin-restore-${key}`}
                onClick={async () => {
                  if (lock.current) return;
                  lock.current = true;
                  setRestoring(key);
                  setError(null);
                  const request = ++revision.current;
                  try {
                    await onRestore(item);
                    if (request === revision.current) {
                      setItems((current) =>
                        current.filter(
                          (entry) => `${entry.kind}-${entry.id}` !== key,
                        ),
                      );
                      await load();
                    }
                  } catch (cause) {
                    if (request === revision.current)
                      setError(
                        cause instanceof Error ? cause.message : String(cause),
                      );
                  } finally {
                    lock.current = false;
                    setRestoring(null);
                  }
                }}
              >
                {restoring === key ? messages.restoring : messages.restore}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
