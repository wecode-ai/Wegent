// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, type ReactNode } from "react";
import { ChevronRight, X } from "lucide-react";

export interface ResourceDestinationOption {
  id: string;
  testId: string;
  label: string;
  description: string;
  icon: ReactNode;
  disabled?: boolean;
  onSelect(): void;
}

export function ResourceDestinationDialog({
  title,
  description,
  closeLabel,
  options,
  onClose,
}: {
  title: string;
  description: string;
  closeLabel: string;
  options: ResourceDestinationOption[];
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);

  return (
    <div
      className="collaboration-resource-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="collaboration-resource-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="resource-destination-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
          if (event.key !== "Tab") return;
          const buttons =
            dialogRef.current?.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            );
          if (!buttons?.length) return;
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header>
          <div>
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
          <button
            type="button"
            aria-label={closeLabel}
            data-testid="resource-destination-close"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="collaboration-resource-create-options">
          {options.map((option) => (
            <button
              type="button"
              key={option.id}
              data-testid={option.testId}
              disabled={option.disabled}
              onClick={() => {
                onClose();
                option.onSelect();
              }}
            >
              {option.icon}
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              <ChevronRight aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
