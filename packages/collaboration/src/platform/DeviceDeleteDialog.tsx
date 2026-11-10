// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";
import type { CollaborationExecutionEnvironment } from "../types";
import { DeviceLastSeen } from "./DeviceLastSeen";
import type { PlatformMessages } from "./platformMessages";

export function DeviceDeleteDialog({
  device,
  protectedRegistration = false,
  workspaceNames,
  locale,
  messages,
  onDelete,
  onClose,
}: {
  device: CollaborationExecutionEnvironment;
  protectedRegistration?: boolean;
  workspaceNames: string[];
  locale: string;
  messages: PlatformMessages;
  onDelete(device: CollaborationExecutionEnvironment): Promise<void>;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const locked = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const otherSpaces = Math.max(
    0,
    (device.workspace_ids?.length ?? 0) - workspaceNames.length,
  );
  const spaceNames = [
    ...workspaceNames,
    ...(otherSpaces
      ? [messages.otherSpaceCount.replace("{{count}}", String(otherSpaces))]
      : []),
  ];
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  const remove = async () => {
    if (locked.current || protectedRegistration) return;
    locked.current = true;
    setPending(true);
    setError(null);
    try {
      await onDelete(device);
      onClose();
    } catch (cause) {
      const status =
        cause && typeof cause === "object" && "status" in cause
          ? cause.status
          : null;
      setError(
        status === 409
          ? messages.deviceDeleteConflict
          : status === 404
            ? messages.deviceDeleteMissing
            : messages.deviceDeleteFailed,
      );
    } finally {
      locked.current = false;
      setPending(false);
    }
  };
  return (
    <div
      className="collaboration-resource-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !locked.current) onClose();
      }}
    >
      <div
        ref={dialog}
        className="collaboration-resource-dialog collaboration-delete-agent-dialog collaboration-delete-device-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={messages.deleteDevice}
        aria-busy={pending}
        data-testid="collaboration-delete-device-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            if (!locked.current) onClose();
          }
          if (event.key !== "Tab") return;
          const buttons = Array.from(
            dialog.current?.querySelectorAll<HTMLButtonElement>(
              'button:not(:disabled), [tabindex="0"]',
            ) ?? [],
          );
          const first = buttons[0],
            last = buttons.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <header>
          <div>
            <h2>{messages.deleteDevice}</h2>
            <p>
              <strong>{device.name}</strong>
              <br />
              {messages.deleteDeviceConfirm}
            </p>
          </div>
        </header>
        <div className="collaboration-delete-device-details">
          <p className="collaboration-device-identifier">
            {messages.deviceIdentifier}: #{device.device_id} ·{" "}
            {device.device_key ?? device.id}
          </p>
          <p>
            {messages.lastSeen}:{" "}
            <DeviceLastSeen
              device={device}
              locale={locale}
              messages={messages}
              now={Date.now()}
            />
          </p>
          {spaceNames.length > 0 ? (
            <p>
              {messages.usedBySpaces}:{" "}
              {new Intl.ListFormat(locale).format(spaceNames)}
            </p>
          ) : null}
        </div>
        {protectedRegistration || error ? (
          <p role="alert" className="collaboration-resource-form-error">
            {protectedRegistration
              ? messages.deviceDeleteIdentityUnresolved
              : error}
          </p>
        ) : null}
        <div className="collaboration-resource-form-actions collaboration-delete-agent-actions">
          <button
            type="button"
            className="collaboration-secondary-button"
            data-testid="collaboration-delete-device-cancel"
            disabled={pending}
            onClick={onClose}
          >
            {messages.cancel}
          </button>
          <button
            type="button"
            className="collaboration-primary-button"
            data-testid="collaboration-delete-device-confirm"
            disabled={pending || protectedRegistration}
            onClick={() => void remove()}
          >
            {pending ? messages.deleting : messages.deleteDevice}
          </button>
        </div>
      </div>
    </div>
  );
}
