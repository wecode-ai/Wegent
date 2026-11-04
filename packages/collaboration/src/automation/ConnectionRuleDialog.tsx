import { useEffect, useState, type ReactNode } from "react";

export function ConnectionRuleDialog({
  children,
  label,
  returnFocus,
}: {
  children: ReactNode;
  label: string;
  returnFocus: HTMLElement | null;
}) {
  const [dialog, setDialog] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!dialog) return;
    const controls = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ),
      ).filter(
        (element) =>
          !element.closest("fieldset:disabled") &&
          element.getClientRects().length > 0,
      );
    const isTopDialog = () =>
      Array.from(
        document.querySelectorAll('[role="dialog"][aria-modal="true"]'),
      ).at(-1) === dialog;
    const constrainFocus = (event: FocusEvent) => {
      if (
        isTopDialog() &&
        event.target instanceof Node &&
        !dialog.contains(event.target)
      )
        (controls()[0] ?? dialog).focus();
    };
    const cycleFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !isTopDialog()) return;
      const items = controls();
      const first = items[0];
      const last = items.at(-1);
      if (
        !first ||
        (event.shiftKey
          ? document.activeElement === first
          : document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? (last ?? dialog) : (first ?? dialog)).focus();
      }
    };
    document.addEventListener("focusin", constrainFocus);
    dialog.addEventListener("keydown", cycleFocus);
    return () => {
      document.removeEventListener("focusin", constrainFocus);
      dialog.removeEventListener("keydown", cycleFocus);
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [dialog, returnFocus]);
  return (
    <div className="collaboration-dialog-backdrop !bg-black/20">
      <div
        ref={setDialog}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl"
      >
        {children}
      </div>
    </div>
  );
}
