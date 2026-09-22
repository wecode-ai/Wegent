// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

export interface ResourceDestinationOption {
  id: string;
  testId: string;
  label: string;
  description: string;
  icon: ReactNode;
  disabled?: boolean;
  children?: ResourceDestinationOption[];
  onSelect?(): void;
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
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [parentOption, setParentOption] =
    useState<ResourceDestinationOption | null>(null);
  const activeOptions = parentOption?.children ?? options;
  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [parentOption]);

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
            if (parentOption) setParentOption(null);
            else onClose();
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
          {parentOption ? (
            <button
              type="button"
              aria-label={closeLabel}
              data-testid="resource-destination-back"
              onClick={() => setParentOption(null)}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
          ) : null}
          <div>
            <h2>{parentOption?.label ?? title}</h2>
            <p>{parentOption?.description ?? description}</p>
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
          {activeOptions.map((option) => (
            <button
              type="button"
              key={option.id}
              data-testid={option.testId}
              disabled={option.disabled}
              onClick={() => {
                if (option.children?.length) {
                  setParentOption(option);
                  return;
                }
                onClose();
                option.onSelect?.();
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
