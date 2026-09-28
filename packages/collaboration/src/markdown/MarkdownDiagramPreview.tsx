import { useCollaborationPortalTheme } from "../theme";
import { useMarkdownServices } from "./MarkdownServices";
import FileViewer from "@file-viewer/react";
import engineeringRenderers from "@file-viewer/preset-engineering";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { DiagramImageActions } from "./DiagramImageActions";
import { useEscapeKey } from "./useEscapeKey";
import { activityClassNames as cn } from "../issue-detail/activityClassNames";

interface MarkdownDiagramPreviewProps {
  code: string;
  language: string;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export function MarkdownDiagramPreview({
  code,
  language,
}: MarkdownDiagramPreviewProps) {
  const portalTheme = useCollaborationPortalTheme();
  const { translate: t, theme, plantumlServerUrl } = useMarkdownServices();
  const containerRef = useRef<HTMLElement>(null);
  const fullscreenDialogRef = useRef<HTMLDivElement>(null);
  const fullscreenExitButtonRef = useRef<HTMLButtonElement>(null);
  const fullscreenTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreFullscreenFocusRef = useRef(false);
  const [fullscreen, setFullscreen] = useState(false);
  const normalizedLanguage = language.toLowerCase();
  const diagramType =
    normalizedLanguage === "mmd" || normalizedLanguage === "mermaid"
      ? "mermaid"
      : "plantuml";
  const file = useMemo(
    () =>
      new File([code], `diagram.${diagramType}`, {
        type: "text/plain",
      }),
    [code, diagramType],
  );
  const options = useMemo(
    () => ({
      preset: [engineeringRenderers],
      drawing: { plantumlServerUrl: plantumlServerUrl },
      theme,
    }),
    [theme, plantumlServerUrl],
  );

  const closeFullscreen = () => setFullscreen(false);
  const openFullscreen = () => {
    restoreFullscreenFocusRef.current = true;
    setFullscreen(true);
  };

  useEscapeKey(closeFullscreen, fullscreen, fullscreenDialogRef);

  useEffect(() => {
    if (fullscreen) {
      const frameId = window.requestAnimationFrame(() =>
        fullscreenExitButtonRef.current?.focus(),
      );
      return () => window.cancelAnimationFrame(frameId);
    }
    if (!restoreFullscreenFocusRef.current) return;

    restoreFullscreenFocusRef.current = false;
    const frameId = window.requestAnimationFrame(() =>
      fullscreenTriggerRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(frameId);
  }, [fullscreen]);

  const handleFullscreenKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;

    const focusableElements = Array.from(
      fullscreenDialogRef.current?.querySelectorAll<HTMLElement>(
        FOCUSABLE_SELECTOR,
      ) ?? [],
    );
    if (focusableElements.length === 0) {
      event.preventDefault();
      fullscreenDialogRef.current?.focus();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  };

  const preview = (
    <section
      data-testid="assistant-diagram-preview"
      data-language={diagramType}
      data-scroll-anchor
      ref={containerRef}
      className={cn(
        "wework-diagram-preview relative max-w-full overflow-hidden bg-background",
        fullscreen
          ? "h-full w-full"
          : "mb-3 mt-2 h-96 rounded-lg border border-border",
      )}
    >
      <FileViewer
        file={file}
        filename={file.name}
        type={diagramType}
        size={file.size}
        className="h-full w-full"
        options={options}
      />
      <DiagramImageActions
        containerRef={containerRef}
        filename={`${diagramType}-diagram.png`}
        theme={theme}
        fullscreen={fullscreen}
        fullscreenButtonRef={
          fullscreen ? fullscreenExitButtonRef : fullscreenTriggerRef
        }
        onToggleFullscreen={fullscreen ? closeFullscreen : openFullscreen}
      />
    </section>
  );

  return (
    <>
      {fullscreen ? (
        <div aria-hidden="true" className="mb-3 mt-2 h-96 max-w-full" />
      ) : (
        preview
      )}
      {fullscreen && typeof document !== "undefined"
        ? createPortal(
            <div
              {...portalTheme}
              ref={fullscreenDialogRef}
              data-testid="assistant-diagram-fullscreen"
              role="dialog"
              aria-modal="true"
              aria-label={t("workbench.diagram_full_screen", "全屏查看")}
              tabIndex={-1}
              onKeyDown={handleFullscreenKeyDown}
              className={`${portalTheme.className} fixed inset-0 z-modal h-dvh w-dvw bg-background`}
            >
              {preview}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
