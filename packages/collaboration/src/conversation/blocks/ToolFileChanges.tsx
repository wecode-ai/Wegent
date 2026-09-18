import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ChevronDown, FileDiff } from "lucide-react";
import { useConversationTranslation } from "../ConversationTranslation";
import type { TurnFileChangeItem } from "@wegent/chat-core/runtime";
import type { ProcessingBlock } from "./types";
import { ActivityShimmerText } from "../../issue-card/ActivityShimmerText";
import { InlineDiffPreview, fileDiffPreviewLines } from "./ToolInlineDiff";
import { basename } from "./toolBlockText";

export function ProcessFileChangesBlockItem({
  block,
  fileEditDurations,
  onExpandedChange,
}: {
  block: Extract<ProcessingBlock, { type: "file_changes" }>;
  fileEditDurations?: FileEditDurationsByBlock;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const { t } = useConversationTranslation();
  const summary = block.fileChanges;
  const isRunning = block.status !== "done" && block.status !== "error";
  const [expandedFilePath, setExpandedFilePath] = useState<string | null>(null);

  useLayoutEffect(() => {
    onExpandedChange?.(expandedFilePath !== null);
  }, [expandedFilePath, onExpandedChange]);

  if (!summary.files.length) return null;

  return (
    <div
      className="min-w-0 overflow-visible text-sm"
      data-processing-block-id={block.id}
      data-testid="process-file-changes-block"
    >
      <div className="flex min-w-0 flex-col">
        {summary.files.map((file) => {
          const previewLines = fileDiffPreviewLines(file, summary);
          const fileExpanded =
            expandedFilePath === file.path && previewLines.length > 0;
          const editDuration = fileEditDurations?.get(block.id)?.get(file.path);
          return (
            <div
              key={`${file.old_path ?? ""}:${file.path}`}
              className="min-w-0"
            >
              <button
                type="button"
                disabled={previewLines.length === 0}
                aria-expanded={
                  previewLines.length > 0 ? fileExpanded : undefined
                }
                onClick={() =>
                  setExpandedFilePath((current) =>
                    current === file.path ? null : file.path,
                  )
                }
                className="group relative z-10 flex min-h-8 w-full max-w-full items-center gap-1.5 text-text-secondary disabled:cursor-default"
              >
                <FileDiff className="h-4 w-4 shrink-0" strokeWidth={1.7} />
                {isRunning ? (
                  <ActivityShimmerText
                    variant="tool"
                    className="min-w-0 truncate"
                  >
                    {fileChangeRowLabel(file, t, isRunning)}
                  </ActivityShimmerText>
                ) : (
                  <span className="min-w-0 truncate">
                    {fileChangeRowLabel(file, t, isRunning)}
                  </span>
                )}
                {!file.binary ? (
                  <FileChangeLineStats
                    file={file}
                    isRunning={isRunning}
                    streamId={block.id}
                  />
                ) : null}
                {previewLines.length > 0 ? (
                  <ChevronDown
                    className={`h-3.5 w-3.5 shrink-0 text-text-muted transition-transform group-hover:text-text-secondary ${
                      fileExpanded ? "" : "-rotate-90"
                    }`}
                    strokeWidth={2}
                  />
                ) : null}
                <FileEditDurationText
                  key={editDuration?.id ?? block.id}
                  duration={editDuration}
                  fallbackStartedAt={block.createdAt}
                  fallbackCompletedAt={block.completedAt}
                  isRunning={isRunning}
                />
              </button>
              {fileExpanded ? (
                <InlineDiffPreview file={file} lines={previewLines} />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface FileEditDuration {
  id: string;
  startedAt: number;
  completedAt?: number;
}

export type FileEditDurationsByBlock = ReadonlyMap<
  string,
  ReadonlyMap<string, FileEditDuration>
>;

type FileChangeStatBlock = {
  id: string;
  additions: number;
  deletions: number;
};

type FileChangeStatBlockStyle = CSSProperties & {
  "--file-change-stat-addition-height": string;
  "--file-change-stat-deletion-height": string;
  "--file-change-stat-blocks-width": string;
  "--file-change-stat-x": string;
  "--file-change-stat-alpha": string;
};

function FileChangeLineStats({
  file,
  isRunning,
  streamId,
}: {
  file: TurnFileChangeItem;
  isRunning: boolean;
  streamId: string;
}) {
  const [statBlocks, setStatBlocks] = useState<FileChangeStatBlock[]>([]);
  const previousRef = useRef({
    streamId,
    additions: file.additions,
    deletions: file.deletions,
  });
  const visibleStatBlocks =
    isRunning && statBlocks.length > 0
      ? statBlocks
      : buildStaticFileChangeStatBlocks(file, streamId);

  useEffect(() => {
    const previous = previousRef.current;
    if (previous.streamId !== streamId) {
      previousRef.current = {
        streamId,
        additions: file.additions,
        deletions: file.deletions,
      };
      setStatBlocks([]);
      return;
    }

    const addedDelta = Math.max(0, file.additions - previous.additions);
    const deletedDelta = Math.max(0, file.deletions - previous.deletions);
    previousRef.current = {
      streamId,
      additions: file.additions,
      deletions: file.deletions,
    };

    if (!isRunning || (addedDelta === 0 && deletedDelta === 0)) return;

    const now = Date.now();
    setStatBlocks((current) =>
      [
        ...current,
        {
          id: `${streamId}:${now}:${addedDelta}:${deletedDelta}`,
          additions: addedDelta,
          deletions: deletedDelta,
        },
      ].slice(-6),
    );
  }, [file.additions, file.deletions, isRunning, streamId]);

  return (
    <span
      className="flex shrink-0 items-center gap-2 text-xs font-medium tabular-nums"
      data-testid="file-change-line-stats"
    >
      <span className="inline-flex items-center text-green-600">
        +
        <AnimatedChangeNumber
          key={`${streamId}:additions`}
          value={file.additions}
          deltaPrefix="+"
        />
      </span>
      <span className="inline-flex items-center text-red-500">
        -
        <AnimatedChangeNumber
          key={`${streamId}:deletions`}
          value={file.deletions}
          deltaPrefix="-"
        />
      </span>
      {visibleStatBlocks.length > 0 ? (
        <FileChangeStatBlocks blocks={visibleStatBlocks} />
      ) : null}
    </span>
  );
}

function buildStaticFileChangeStatBlocks(
  file: TurnFileChangeItem,
  streamId: string,
): FileChangeStatBlock[] {
  if (file.additions === 0 && file.deletions === 0) return [];
  return [
    {
      id: `${streamId}:${file.path}:${file.additions}:${file.deletions}`,
      additions: file.additions,
      deletions: file.deletions,
    },
  ];
}

function AnimatedChangeNumber({
  value,
  deltaPrefix,
}: {
  value: number;
  deltaPrefix: "+" | "-";
}) {
  const previousValueRef = useRef(value);
  const [delta, setDelta] = useState(0);
  const [animationId, setAnimationId] = useState(0);

  useEffect(() => {
    if (previousValueRef.current === value) return;
    const deltaValue = Math.abs(value - previousValueRef.current);
    previousValueRef.current = value;
    setDelta(0);
    const frame = requestAnimationFrame(() => {
      setDelta(deltaValue);
      setAnimationId((current) => current + 1);
    });
    const timeout = window.setTimeout(() => setDelta(0), 560);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [value]);

  return (
    <span className="file-change-delta-number">
      <span className="file-change-rolling-viewport">
        <span
          key={`${value}-${animationId}`}
          className={`file-change-rolling-value ${delta > 0 ? "is-rolling" : ""}`}
        >
          {value}
        </span>
      </span>
      {delta > 0 ? (
        <span
          key={`${deltaPrefix}${delta}-${value}`}
          className="file-change-delta-badge"
        >
          {deltaPrefix}
          {delta}
        </span>
      ) : null}
    </span>
  );
}

function FileChangeStatBlocks({ blocks }: { blocks: FileChangeStatBlock[] }) {
  const width = Math.max(6, (blocks.length - 1) * 7 + 6);

  return (
    <span
      className="file-change-stat-blocks"
      aria-hidden="true"
      style={
        {
          "--file-change-stat-blocks-width": `${width}px`,
        } as FileChangeStatBlockStyle
      }
    >
      {blocks.map((block, index) => {
        const age = blocks.length - index - 1;
        const additionHeight =
          block.additions > 0 ? Math.min(10, 3 + block.additions * 1.6) : 0;
        const deletionHeight =
          block.deletions > 0 ? Math.min(10, 3 + block.deletions * 1.6) : 0;
        return (
          <span
            key={block.id}
            className="file-change-stat-block"
            style={
              {
                "--file-change-stat-addition-height": `${additionHeight}px`,
                "--file-change-stat-deletion-height": `${deletionHeight}px`,
                "--file-change-stat-x": `${index * 7}px`,
                "--file-change-stat-alpha": `${Math.max(0.28, 0.96 - age * 0.11)}`,
              } as FileChangeStatBlockStyle
            }
          >
            {block.additions > 0 ? (
              <span className="file-change-stat-segment is-addition" />
            ) : null}
            {block.deletions > 0 ? (
              <span className="file-change-stat-segment is-deletion" />
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

function FileEditDurationText({
  duration,
  fallbackStartedAt,
  fallbackCompletedAt,
  isRunning,
}: {
  duration: FileEditDuration | undefined;
  fallbackStartedAt: number;
  fallbackCompletedAt: number | undefined;
  isRunning: boolean;
}) {
  const durationIsRunning = duration
    ? duration.completedAt === undefined
    : isRunning;
  const text = useToolDuration(
    duration?.startedAt ?? fallbackStartedAt,
    duration?.completedAt ?? fallbackCompletedAt,
    durationIsRunning,
  );

  return (
    <span className="ml-auto shrink-0 pl-2 font-mono text-xs text-text-muted">
      {text}
    </span>
  );
}

export function useToolDuration(
  startedAt: number,
  fallbackEndAt: number | undefined,
  isRunning: boolean,
) {
  const [now, setNow] = useState(() => Date.now());
  const [anchoredStartedAt] = useState(startedAt);
  const wasRunning = useRef(isRunning);
  const [completedAt, setCompletedAt] = useState<number | null>(null);

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  useEffect(() => {
    if (wasRunning.current && !isRunning) setCompletedAt(Date.now());
    wasRunning.current = isRunning;
  }, [isRunning]);

  const durationStartedAt =
    fallbackEndAt === undefined ? anchoredStartedAt : startedAt;
  const endedAt = isRunning
    ? now
    : (fallbackEndAt ?? completedAt ?? anchoredStartedAt);
  if (!isRunning && completedAt === null && fallbackEndAt === undefined)
    return "";
  return `${(Math.max(0, endedAt - durationStartedAt) / 1000).toFixed(1)}s`;
}

function fileChangeRowLabel(
  file: TurnFileChangeItem,
  t: ReturnType<typeof useConversationTranslation>["t"],
  isRunning = false,
): string {
  const filename = basename(file.path);
  if (isRunning) {
    if (file.change_type === "created")
      return t("file_changes.creating_file", { filename });
    if (file.change_type === "deleted")
      return t("file_changes.deleting_file", { filename });
    if (file.change_type === "renamed")
      return t("file_changes.renaming_file", { filename });
    return t("file_changes.editing_file", { filename });
  }
  switch (file.change_type) {
    case "created":
      return t("tool_activity.created_file", { filename });
    case "deleted":
      return t("tool_activity.deleted_file", { filename });
    case "renamed":
      return t("tool_activity.renamed_file", { filename });
    case "modified":
    default:
      return t("tool_activity.edited_file", { filename });
  }
}
