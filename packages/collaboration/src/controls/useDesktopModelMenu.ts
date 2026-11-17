import {
  useEffect,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useEscapeKey } from "../markdown/useEscapeKey";

const itemSelector = '[role="menuitemradio"]';

function focusItem(menu: HTMLElement, item: HTMLElement | undefined) {
  if (!item) return;
  for (const option of menu.querySelectorAll<HTMLElement>(itemSelector)) {
    option.tabIndex = option === item ? 0 : -1;
  }
  item.focus();
}

/** Keyboard ownership applies only to the model choices, not the reasoning form. */
export function useDesktopModelMenu({
  open,
  active,
  menuRef,
  simplePanelRef,
  triggerRef,
  wrapperRef,
  onClose,
}: {
  open: boolean;
  active: boolean;
  menuRef: RefObject<HTMLDivElement | null>;
  simplePanelRef: RefObject<HTMLDivElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  wrapperRef: RefObject<HTMLDivElement | null>;
  onClose(): void;
}) {
  useEscapeKey(
    () => {
      onClose();
      triggerRef.current?.focus();
    },
    open,
    wrapperRef,
  );
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    if (active && menu) {
      focusItem(
        menu,
        menu.querySelector<HTMLElement>(
          `${itemSelector}[aria-checked="true"]`,
        ) ??
          menu.querySelector<HTMLElement>(itemSelector) ??
          undefined,
      );
    } else {
      simplePanelRef.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
    }
  }, [active, menuRef, open, simplePanelRef]);

  return {
    onFocusCapture(event: FocusEvent<HTMLDivElement>) {
      if (
        !(event.target instanceof HTMLElement) ||
        !event.target.matches(itemSelector)
      )
        return;
      focusItem(event.currentTarget, event.target);
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (event.key === "Tab") {
        onClose();
        // Let the browser continue forward/reverse Tab navigation from the trigger.
        triggerRef.current?.focus();
        return;
      }
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
      )
        return;
      const items = [
        ...event.currentTarget.querySelectorAll<HTMLElement>(itemSelector),
      ];
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : index < 0
              ? event.key === "ArrowDown"
                ? 0
                : items.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
                items.length;
      event.preventDefault();
      event.stopPropagation();
      focusItem(event.currentTarget, items[next]);
    },
  };
}
