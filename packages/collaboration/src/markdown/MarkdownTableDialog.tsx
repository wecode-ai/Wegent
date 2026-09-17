import { useCollaborationPortalTheme } from "../theme";
import { useMarkdownServices } from "./MarkdownServices";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "./Button";
import { Tooltip } from "../issue-detail/Tooltip";
import { useEscapeKey } from "./useEscapeKey";

export function MarkdownTableDialog({
  children,
  onClose,
  triggerRef,
}: {
  children: ReactNode;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const portalTheme = useCollaborationPortalTheme();
  const { translate: t } = useMarkdownServices();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEscapeKey(onClose);

  useEffect(() => {
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [triggerRef]);

  return createPortal(
    <div
      {...portalTheme}
      data-testid="markdown-table-dialog-overlay"
      className={`${portalTheme.className} fixed inset-0 z-modal flex items-center justify-center bg-black/70 p-4 md:p-8`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("table.expand")}
        data-testid="markdown-table-dialog"
        className="relative flex max-h-[85dvh] w-full max-w-[90rem] flex-col rounded-[20px] border border-border bg-background p-6 pt-12 text-text-primary shadow-lg md:p-12"
        onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const elements = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
            ) ?? [],
          );
          const index = elements.indexOf(document.activeElement as HTMLElement);
          const next =
            (index + (event.shiftKey ? -1 : 1) + elements.length) %
            elements.length;
          event.preventDefault();
          elements[next]?.focus();
        }}
      >
        <div className="absolute right-2 top-2 md:right-3 md:top-3">
          <Tooltip label={t("table.close")}>
            <Button
              ref={closeRef}
              type="button"
              variant="ghost"
              size="icon"
              className="h-11 w-11 text-text-secondary md:h-7 md:w-7"
              aria-label={t("table.close")}
              data-testid="markdown-table-close-button"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          </Tooltip>
        </div>
        <div className="min-h-0 overflow-auto">
          <table className="w-full min-w-max border-collapse text-chat [&_td]:py-4 [&_th]:py-3">
            {children}
          </table>
        </div>
      </div>
    </div>,
    document.body,
  );
}
