import { useState } from "react";
import {
  Archive,
  ChevronDown,
  FileText,
  MessageCircle,
  Pencil,
  Search,
  SquareTerminal,
} from "lucide-react";
import { useConversationTranslation } from "../ConversationTranslation";
import type { ToolBlock } from "./types";
import { ActivityShimmerText } from "../../issue-card/ActivityShimmerText";
import { ToolBlockItem } from "./ToolBlockItem";
import {
  getToolActivityFilePaths,
  getToolActivityGroupKind,
  getToolActivityKind,
  getToolActivitySearchItem,
  isCommandToolName,
  isGuidanceActivityGroup,
  isWebSearchActivityGroup,
  type ProcessingDisplayRow,
} from "./toolBlockActivity";
import { isImageViewToolName } from "./toolBlockKinds";
import { WebSearchActivityRows } from "./WebSearchSources";
import { getWebSearchActivityItems } from "./webSearchActivity";
import { CollapsibleProcessingContent } from "./ProcessingPreview";

export function countProcessingActivityKinds(rows: ProcessingDisplayRow[]) {
  const stats = { command: 0, file: 0, search: 0, edit: 0, other: 0 };

  const addToolBlock = (block: ToolBlock) => {
    const kind = getToolActivityKind(block);
    if (kind === "command") stats.command += 1;
    else if (kind === "file") stats.file += 1;
    else if (kind === "search") stats.search += 1;
    else if (kind === "edit" || kind === "create") stats.edit += 1;
    else stats.other += 1;
  };

  rows.forEach((row) => {
    if (row.type === "activity_group") {
      row.blocks.forEach(addToolBlock);
      return;
    }
    if (row.block.type === "tool") {
      addToolBlock(row.block);
      return;
    }
    if (row.block.type === "file_changes") {
      stats.edit +=
        row.block.fileChanges.file_count || row.block.fileChanges.files.length;
    }
  });

  return stats;
}

export function countProcessingToolCalls(
  stats: ReturnType<typeof countProcessingActivityKinds>,
): number {
  return stats.command + stats.file + stats.search + stats.other;
}

export function ToolActivityGroup({
  row,
  initialExpanded = true,
  onOpenWorkspaceFile,
}: {
  row: Extract<ProcessingDisplayRow, { type: "activity_group" }>;
  initialExpanded?: boolean;
  onOpenWorkspaceFile?: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const isWebSearchGroup = isWebSearchActivityGroup(row.blocks);
  const isGuidanceGroup = isGuidanceActivityGroup(row.blocks);
  const icon = renderActivityGroupIcon(row.blocks);

  if (isGuidanceGroup) {
    return (
      <div
        className="flex max-w-full items-center gap-1.5 text-sm text-text-muted"
        data-testid="processing-activity-group-label"
      >
        {icon}
        <span className="min-w-0 truncate">{row.label}</span>
      </div>
    );
  }

  return (
    <div className="min-w-0 overflow-x-clip text-sm">
      <button
        type="button"
        data-testid="processing-activity-group-toggle"
        data-tool-detail-toggle
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex max-w-full items-center gap-1.5 text-text-muted hover:text-text-secondary"
      >
        {icon}
        <span className="min-w-0 truncate">{row.label}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${expanded ? "" : "-rotate-90"}`}
          strokeWidth={2}
        />
      </button>
      <CollapsibleProcessingContent
        expanded={expanded}
        testId="processing-activity-group-content"
      >
        <div className="mt-1.5 flex min-w-0 flex-col gap-1.5">
          {isWebSearchGroup ? (
            <WebSearchActivityDetails blocks={row.blocks} />
          ) : (
            <ToolActivityDetails
              blocks={row.blocks}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          )}
        </div>
      </CollapsibleProcessingContent>
    </div>
  );
}

export function ContextCompactionIndicator({ block }: { block: ToolBlock }) {
  const label = getContextCompactionLabel(block);
  const isRunning = block.status !== "done" && block.status !== "error";
  const textClassName =
    block.status === "error" ? "text-red-500" : "text-text-muted";

  return (
    <div
      className="flex w-full min-w-0 items-center gap-3 py-1"
      data-testid="context-compaction-indicator"
      aria-label={label}
    >
      <span className="h-px min-w-6 flex-1 bg-border" aria-hidden="true" />
      <span
        className={`inline-flex min-w-0 max-w-full items-center gap-1.5 text-sm font-semibold ${textClassName}`}
      >
        <Archive
          className="h-4 w-4 shrink-0"
          strokeWidth={1.7}
          aria-hidden="true"
        />
        {isRunning ? (
          <ActivityShimmerText variant="thinking" className="min-w-0 truncate">
            {label}
          </ActivityShimmerText>
        ) : (
          <span className="min-w-0 truncate">{label}</span>
        )}
      </span>
      <span className="h-px min-w-6 flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}

function getContextCompactionLabel(block: ToolBlock): string {
  if (block.status === "error") return "上下文压缩失败";
  if (block.status === "done") return "上下文已自动压缩";
  return "正在自动压缩上下文";
}

function WebSearchActivityDetails({ blocks }: { blocks: ToolBlock[] }) {
  const items = getWebSearchActivityItems(blocks);

  if (items.length === 0) return null;

  return <WebSearchActivityRows items={items} />;
}

function ToolActivityDetails({
  blocks,
  onOpenWorkspaceFile,
}: {
  blocks: ToolBlock[];
  onOpenWorkspaceFile?: (path: string) => void;
}) {
  return (
    <>
      {blocks.map((block) => {
        if (isImageViewToolName(block.toolName)) {
          return (
            <ToolBlockItem
              key={block.id}
              block={block}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          );
        }

        const item = getToolActivitySearchItem(block);
        if (item) {
          return <CodeSearchActivityRow key={item.id} label={item.label} />;
        }

        const paths = getToolActivityFilePaths(block);
        if (paths.length > 0) {
          return paths.map((path) => (
            <FileReadActivityRow
              key={`${block.id}:${path}`}
              path={path}
              onOpenWorkspaceFile={onOpenWorkspaceFile}
            />
          ));
        }

        return (
          <ToolBlockItem
            key={block.id}
            block={block}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
          />
        );
      })}
    </>
  );
}

function CodeSearchActivityRow({ label }: { label: string }) {
  return (
    <div
      data-testid="code-search-activity-row"
      className="flex max-w-full items-start gap-1.5 text-sm leading-5 text-text-muted"
    >
      <Search
        className="mt-0.5 h-4 w-4 shrink-0"
        strokeWidth={1.7}
        aria-hidden="true"
      />
      <span className="min-w-0 break-words">{label}</span>
    </div>
  );
}

function FileReadActivityRow({
  path,
  onOpenWorkspaceFile,
}: {
  path: string;
  onOpenWorkspaceFile?: (path: string) => void;
}) {
  const { t } = useConversationTranslation();
  const label = t("tool_activity.file_done", { name: basename(path) });
  const content = (
    <span data-testid="file-read-activity-row" className="min-w-0 truncate">
      {label}
    </span>
  );

  if (onOpenWorkspaceFile) {
    return (
      <button
        type="button"
        data-testid="file-read-activity-button"
        className="flex max-w-full items-center gap-1.5 text-left text-text-muted hover:text-text-secondary"
        onClick={() => onOpenWorkspaceFile(path)}
      >
        <FileText
          className="h-4 w-4 shrink-0"
          strokeWidth={1.7}
          aria-hidden="true"
        />
        {content}
      </button>
    );
  }

  return (
    <div className="flex max-w-full items-center gap-1.5 text-text-muted">
      <FileText
        className="h-4 w-4 shrink-0"
        strokeWidth={1.7}
        aria-hidden="true"
      />
      {content}
    </div>
  );
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function hasCommandBlocks(blocks: ToolBlock[]): boolean {
  return blocks.some((block) => isCommandToolName(block.toolName));
}

function hasCodeSearchBlocks(blocks: ToolBlock[]): boolean {
  return blocks.some((block) => getToolActivityKind(block) === "search");
}

function renderActivityGroupIcon(blocks: ToolBlock[]) {
  if (hasCodeSearchBlocks(blocks)) {
    return (
      <Search
        data-testid="processing-activity-search-icon"
        className="h-4 w-4 shrink-0"
        strokeWidth={1.7}
      />
    );
  }
  if (hasCommandBlocks(blocks)) {
    return <SquareTerminal className="h-4 w-4 shrink-0" strokeWidth={1.7} />;
  }
  if (isGuidanceActivityGroup(blocks)) {
    return <MessageCircle className="h-4 w-4 shrink-0" strokeWidth={1.7} />;
  }
  const kind = getToolActivityGroupKind(blocks);
  if (kind === "edit") {
    return (
      <Pencil
        data-testid="processing-activity-edit-icon"
        className="h-4 w-4 shrink-0"
        strokeWidth={1.7}
      />
    );
  }
  if (kind === "create" || kind === "file") {
    return (
      <FileText
        data-testid="processing-activity-file-icon"
        className="h-4 w-4 shrink-0"
        strokeWidth={1.7}
      />
    );
  }
  return <Search className="h-4 w-4 shrink-0" strokeWidth={1.7} />;
}
