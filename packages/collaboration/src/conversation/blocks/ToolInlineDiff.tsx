import { useToolInteractionServices } from "../ToolInteractionServices";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Copy, CopyCheck } from "lucide-react";
import { useConversationTranslation } from "../ConversationTranslation";
import type {
  TurnFileChangeItem,
  TurnFileChangesSummary,
} from "@wegent/chat-core/runtime";
import { parseUnifiedDiff } from "../parseUnifiedDiff";
import { basename } from "./toolBlockText";

const INLINE_DIFF_MAX_LINES = 96;

export function InlineDiffPreview({
  file,
  lines,
}: {
  file: TurnFileChangeItem;
  lines: DiffPreviewLine[];
}) {
  const { t } = useConversationTranslation();
  const interactions = useToolInteractionServices();
  const previewRef = useLockedMessageContentVisibility();
  const [copied, setCopied] = useState(false);
  const copyResetTimerRef = useRef<number | null>(null);
  const isDisposedRef = useRef(false);
  const visibleLines = lines.slice(0, INLINE_DIFF_MAX_LINES);
  const truncated = lines.length > INLINE_DIFF_MAX_LINES;
  const copyText = formatDiffPreviewCopyText(visibleLines, truncated);

  useEffect(() => {
    isDisposedRef.current = false;
    return () => {
      isDisposedRef.current = true;
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
        copyResetTimerRef.current = null;
      }
    };
  }, []);

  const handleCopy = async () => {
    await copyCodeText(copyText);
    if (isDisposedRef.current) return;
    interactions.onOutputAction?.("copy");
    setCopied(true);
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copyResetTimerRef.current = null;
    }, 1500);
  };

  return (
    <div
      ref={previewRef}
      className="mt-2 max-h-[16rem] min-w-0 select-text overflow-auto overscroll-contain rounded-lg border border-border bg-surface font-mono text-xs leading-[18px]"
      data-testid="process-file-change-diff"
      data-message-content-visibility-lock="true"
      onClick={(event) => event.stopPropagation()}
    >
      <div
        data-testid="process-file-change-diff-header"
        className="sticky top-0 z-10 flex h-8 items-center justify-between gap-2 border-b border-border bg-surface px-3 font-sans text-xs text-text-secondary"
      >
        <span
          data-testid="process-file-change-diff-header-content"
          className="flex min-w-0 flex-1 items-center gap-2"
        >
          <span className="min-w-0 truncate">{basename(file.path)}</span>
          <span
            data-testid="process-file-change-diff-stats"
            className="flex shrink-0 items-center gap-1.5 font-medium"
          >
            <span className="text-green-600">+{file.additions}</span>
            <span className="text-red-500">-{file.deletions}</span>
          </span>
        </span>
        <button
          type="button"
          data-testid="copy-process-file-change-diff-button"
          aria-label={t("file_changes.copy_code")}
          title={t("file_changes.copy_code")}
          onClick={(event) => {
            event.stopPropagation();
            void handleCopy();
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {copied ? (
            <CopyCheck
              className="h-3.5 w-3.5"
              strokeWidth={2}
              data-testid="process-file-change-diff-copy-success-icon"
            />
          ) : (
            <Copy
              className="h-3.5 w-3.5"
              strokeWidth={2}
              data-testid="process-file-change-diff-copy-icon"
            />
          )}
        </button>
      </div>
      <div className="py-1">
        {visibleLines.map((line) => (
          <div
            key={line.key}
            className={[
              "grid min-w-max grid-cols-[3.25rem_max-content]",
              line.type === "addition"
                ? "border-l-4 border-green-500 bg-green-500/10"
                : line.type === "deletion"
                  ? "border-l-4 border-red-500 bg-red-500/10"
                  : line.type === "separator"
                    ? "border-l-4 border-transparent bg-muted/60"
                    : "border-l-4 border-transparent",
            ].join(" ")}
          >
            <span
              className={[
                "select-none px-3 text-right",
                line.type === "addition"
                  ? "text-green-600"
                  : line.type === "deletion"
                    ? "text-red-500"
                    : "text-text-muted",
              ].join(" ")}
            >
              {line.lineNumber ?? ""}
            </span>
            <span className="pr-4 whitespace-pre text-text-primary">
              {line.content || " "}
            </span>
          </div>
        ))}
        {truncated ? (
          <div className="px-3 py-1 text-xs text-text-muted">...</div>
        ) : null}
      </div>
    </div>
  );
}

function useLockedMessageContentVisibility() {
  const previewRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const article =
      previewRef.current?.closest<HTMLElement>("[data-message-id]");
    if (!article) return;

    const previousContentVisibility = article.style.contentVisibility;
    article.style.contentVisibility = "visible";

    return () => {
      article.style.contentVisibility = previousContentVisibility;
    };
  }, []);

  return previewRef;
}

interface DiffPreviewLine {
  key: string;
  type: "addition" | "deletion" | "context" | "separator";
  lineNumber?: number;
  content: string;
}

function formatDiffPreviewCopyText(
  lines: DiffPreviewLine[],
  truncated: boolean,
): string {
  const formatted = lines.map((line) => {
    if (line.type === "separator") return "";
    if (line.type === "addition") return `+${line.content}`;
    if (line.type === "deletion") return `-${line.content}`;
    return ` ${line.content}`;
  });

  if (truncated) formatted.push("...");
  return formatted.join("\n");
}

async function copyCodeText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

export function fileDiffPreviewLines(
  file: TurnFileChangeItem,
  summary: TurnFileChangesSummary,
): DiffPreviewLine[] {
  if (file.binary || !summary.diff?.trim()) return [];
  const sectionLines = fileDiffLines(file, summary);
  return parseDiffPreviewLines(sectionLines, file.change_type);
}

function fileDiffLines(
  file: TurnFileChangeItem,
  summary: TurnFileChangesSummary,
): string[] {
  const diff = summary.diff?.trimEnd();
  if (!diff) return [];

  const sections = parseUnifiedDiff(diff);
  if (sections.length === 0) {
    return summary.files.length === 1 ? diff.split("\n") : [];
  }

  const section = sections.find(
    (item) =>
      pathsMatch(item.path, file.path) ||
      (file.old_path ? pathsMatch(item.oldPath, file.old_path) : false),
  );
  return section?.lines ?? [];
}

function pathsMatch(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
  );
}

function parseDiffPreviewLines(
  lines: string[],
  changeType: TurnFileChangeItem["change_type"],
): DiffPreviewLine[] {
  const previewLines: DiffPreviewLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  let seenHunk = false;

  lines.forEach((rawLine, index) => {
    if (
      rawLine.startsWith("diff --git") ||
      rawLine.startsWith("---") ||
      rawLine.startsWith("+++") ||
      rawLine.startsWith("index ")
    ) {
      return;
    }

    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      if (seenHunk && previewLines.length > 0) {
        previewLines.push({
          key: `separator-${index}`,
          type: "separator",
          content: "",
        });
      }
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      seenHunk = true;
      return;
    }

    if (!seenHunk && !rawLine.startsWith("+") && !rawLine.startsWith("-"))
      return;

    const prefix = rawLine[0];
    if (prefix === "+") {
      previewLines.push({
        key: `addition-${index}`,
        type: diffPreviewLineType(prefix, changeType),
        lineNumber: newLine ?? oldLine,
        content: rawLine.slice(1),
      });
      if (newLine !== undefined) newLine += 1;
      return;
    }
    if (prefix === "-") {
      previewLines.push({
        key: `deletion-${index}`,
        type: diffPreviewLineType(prefix, changeType),
        lineNumber: oldLine ?? newLine,
        content: rawLine.slice(1),
      });
      if (oldLine !== undefined) oldLine += 1;
      return;
    }

    previewLines.push({
      key: `context-${index}`,
      type: "context",
      lineNumber: newLine ?? oldLine,
      content: prefix === " " ? rawLine.slice(1) : rawLine,
    });
    if (oldLine !== undefined) oldLine += 1;
    if (newLine !== undefined) newLine += 1;
  });

  return previewLines;
}

function diffPreviewLineType(
  prefix: "+" | "-",
  changeType: TurnFileChangeItem["change_type"],
): DiffPreviewLine["type"] {
  // Runtime patches can be reversed, but the file summary remains the
  // authoritative semantic direction for whole-file creation and deletion.
  if (changeType === "created") return "addition";
  if (changeType === "deleted") return "deletion";
  return prefix === "+" ? "addition" : "deletion";
}
