import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, TransitionEvent } from "react";
import {
  ChevronDown,
  FileText,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import { CompositedSpinner } from "../../issue-detail/CompositedSpinner";
import type { SubagentBlock } from "./types";
import { AssistantThinkingIndicator } from "../AssistantThinkingIndicator";
import { ToolBlockItem } from "./ToolBlockItem";
import type { FileEditDurationsByBlock } from "./ToolFileChanges";
import {
  isContextCompactionToolBlock,
  type ProcessingDisplayRow,
} from "./toolBlockActivity";
import { SubagentActivityGroup } from "./SubagentBlockItem";
import { useAnyDisclosureOpen } from "./disclosureState";
import { getRowDisclosureKeys } from "./disclosureKeys";
import { type ToolActivityLabels } from "./processingDisplayTypes";
import {
  countProcessingActivityKinds,
  ToolActivityGroup,
  ContextCompactionIndicator,
} from "./ProcessingActivity";

export function ProcessingSummaryHeader({
  canToggle,
  duration,
  expanded,
  isRunning,
  rows,
  onToggle,
  title,
  labels,
}: {
  canToggle: boolean;
  duration: string;
  expanded: boolean;
  isRunning: boolean;
  rows: ProcessingDisplayRow[];
  onToggle: () => void;
  title: string;
  labels: ToolActivityLabels;
}) {
  const titleContent = (
    <>
      {rows.length > 0 ? (
        <ChevronDown
          data-testid="processing-summary-chevron"
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`}
          strokeWidth={2}
          aria-hidden="true"
        />
      ) : null}
      <span className="font-medium text-text-secondary">{title}</span>
    </>
  );

  return (
    <div
      className="flex min-h-8 min-w-0 items-center gap-2 text-xs text-text-muted"
      data-testid="processing-summary-header"
    >
      {canToggle ? (
        <button
          type="button"
          data-testid="processing-summary-toggle"
          className="inline-flex shrink-0 items-center gap-1 hover:text-text-primary"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={
            duration ? `${title} 已处理 ${duration}` : `${title} 已处理`
          }
        >
          {titleContent}
        </button>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1">
          {titleContent}
        </span>
      )}
      <ToolActivityStats rows={rows} labels={labels} />
      {isRunning || duration ? (
        <span className="ml-auto inline-flex shrink-0 items-center gap-1">
          {isRunning ? (
            <CompositedSpinner
              className="h-3 w-3 text-blue-500"
              strokeWidth={1.8}
            />
          ) : null}
          {duration}
        </span>
      ) : null}
    </div>
  );
}

function ToolActivityStats({
  rows,
  labels,
}: {
  rows: ProcessingDisplayRow[];
  labels: ToolActivityLabels;
}) {
  const stats = countProcessingActivityKinds(rows);
  const items = [
    {
      key: "command",
      count: stats.command,
      label: labels.command,
      icon: SquareTerminal,
    },
    { key: "file", count: stats.file, label: labels.file, icon: FileText },
    { key: "search", count: stats.search, label: labels.search, icon: Search },
    { key: "edit", count: stats.edit, label: labels.edit, icon: Pencil },
    { key: "other", count: stats.other, label: labels.other, icon: Wrench },
  ].filter((item) => item.count > 0);

  if (items.length === 0) return null;

  return (
    <div
      className="flex min-w-0 items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-testid="processing-tool-stats"
    >
      {items.map(({ key, count, label, icon: Icon }) => (
        <span
          key={key}
          className="inline-flex shrink-0 items-center gap-1"
          title={`${label} ${count}`}
          aria-label={`${label} ${count}`}
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={1.7} aria-hidden="true" />
          <span className="font-mono">{count}</span>
        </span>
      ))}
    </div>
  );
}

export function LiveProcessingPreview({
  rows,
  showThinking,
  thinkingContent,
  onOpenWorkspaceFile,
  fileEditDurations,
  disclosureScope,
  onOpenSubagent,
}: {
  rows: ProcessingDisplayRow[];
  showThinking: boolean;
  thinkingContent: string;
  onOpenWorkspaceFile?: (path: string) => void;
  fileEditDurations: FileEditDurationsByBlock;
  disclosureScope?: string;
  onOpenSubagent?: (block: SubagentBlock) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowDisclosureKeys = useMemo(
    () => getRowDisclosureKeys(disclosureScope, rows),
    [disclosureScope, rows],
  );
  // Whether the reader has anything open inside is read from the same store the rows keep
  // their state in, so the cap lifts again on the first frame after a remount instead of
  // waiting for a row to report itself back.
  const hasExpandedDetail = useAnyDisclosureOpen(rowDisclosureKeys);

  useLayoutEffect(() => {
    if (hasExpandedDetail) return;
    const scrollArea = scrollRef.current;
    if (scrollArea) scrollArea.scrollTop = scrollArea.scrollHeight;
  }, [hasExpandedDetail]);

  useLayoutEffect(() => {
    const scrollArea = scrollRef.current;
    if (!scrollArea) return;
    scrollArea.scrollTop = scrollArea.scrollHeight;
  }, [rows.length, showThinking]);

  return (
    <div
      className="ml-2 min-w-0 border-l border-border pl-3"
      data-testid="processing-live-preview"
    >
      <div
        ref={scrollRef}
        className="scrollbar-soft flex min-w-0 flex-col"
        data-testid="processing-live-preview-scroll"
        style={{
          maxHeight: hasExpandedDetail ? "none" : "7rem",
          overflowY: hasExpandedDetail ? "visible" : "auto",
        }}
      >
        {rows.map((row) => (
          <LiveProcessingPreviewRow
            key={row.id}
            row={row}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
            fileEditDurations={fileEditDurations}
            disclosureScope={disclosureScope}
            onOpenSubagent={onOpenSubagent}
          />
        ))}
        {showThinking ? (
          <div
            className="flex min-h-8 items-center py-1 text-sm"
            data-testid="tool-block-thinking"
          >
            <AssistantThinkingIndicator
              content={thinkingContent}
              testId="tool-thinking-indicator"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LiveProcessingPreviewRow({
  row,
  durationStartedAt,
  durationEndAt,
  fileEditDurations,
  onOpenWorkspaceFile,
  disclosureScope,
  onOpenSubagent,
}: {
  row: ProcessingDisplayRow;
  durationStartedAt?: number;
  durationEndAt?: number;
  fileEditDurations: FileEditDurationsByBlock;
  onOpenWorkspaceFile?: (path: string) => void;
  disclosureScope?: string;
  onOpenSubagent?: (block: SubagentBlock) => void;
}) {
  if (row.type === "activity_group") {
    return (
      <div className="min-h-8 min-w-0 py-1">
        <ToolActivityGroup
          row={row}
          initialExpanded={false}
          onOpenWorkspaceFile={onOpenWorkspaceFile}
        />
      </div>
    );
  }

  if (row.block.type === "tool") {
    if (isContextCompactionToolBlock(row.block)) {
      return <ContextCompactionIndicator block={row.block} />;
    }

    return (
      <ToolBlockItem
        block={row.block}
        compact
        durationStartedAt={durationStartedAt}
        durationEndAt={durationEndAt}
        fileEditDurations={fileEditDurations}
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        disclosureScope={disclosureScope}
      />
    );
  }

  if (row.block.type === "subagent") {
    return (
      <SubagentActivityGroup
        blocks={[row.block]}
        onOpenSubagent={onOpenSubagent}
      />
    );
  }

  return (
    <ToolBlockItem
      block={row.block}
      durationStartedAt={durationStartedAt}
      durationEndAt={durationEndAt}
      fileEditDurations={fileEditDurations}
      disclosureScope={disclosureScope}
    />
  );
}

export function CollapsibleProcessingContent({
  expanded,
  children,
  keepMounted = false,
  testId = "processing-collapse-content",
}: {
  expanded: boolean;
  children: ReactNode;
  keepMounted?: boolean;
  testId?: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const previousExpandedRef = useRef(expanded);
  const [isRendered, setIsRendered] = useState(() => expanded || keepMounted);
  const [maxHeight, setMaxHeight] = useState(() => (expanded ? "none" : "0px"));
  const shouldRender = expanded || keepMounted || isRendered;

  if (expanded && !isRendered) {
    setIsRendered(true);
  }

  useLayoutEffect(() => {
    if (!shouldRender) return;

    const content = contentRef.current;
    if (!content) return;

    const wasExpanded = previousExpandedRef.current;
    let frame: number | undefined;

    if (expanded) {
      setMaxHeight(wasExpanded ? "none" : `${content.scrollHeight}px`);
    } else {
      if (wasExpanded) {
        setMaxHeight(`${content.scrollHeight}px`);
        frame = requestAnimationFrame(() => setMaxHeight("0px"));
      } else {
        setMaxHeight("0px");
      }
    }

    previousExpandedRef.current = expanded;

    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [expanded, shouldRender]);

  const handleTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.propertyName !== "max-height") return;
    if (expanded) {
      setMaxHeight("none");
      return;
    }
    if (!keepMounted) setIsRendered(false);
  };
  const allowOverflow = expanded && maxHeight === "none";

  return (
    <div
      data-testid={testId}
      aria-hidden={!expanded}
      inert={!expanded ? true : undefined}
      onTransitionEnd={handleTransitionEnd}
      className={[
        "transition-[max-height,opacity] [transition-duration:260ms] [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
        allowOverflow ? "overflow-visible" : "overflow-hidden",
        expanded ? "opacity-100" : "pointer-events-none opacity-0",
      ].join(" ")}
      style={{ maxHeight }}
    >
      {shouldRender ? (
        <div
          ref={contentRef}
          className={[
            "min-h-0 transition-transform [transition-duration:260ms] [transition-timing-function:cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
            allowOverflow ? "overflow-visible" : "overflow-hidden",
            expanded ? "translate-y-0" : "-translate-y-1",
          ].join(" ")}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
