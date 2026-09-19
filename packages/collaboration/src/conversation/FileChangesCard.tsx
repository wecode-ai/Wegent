import {
  Check,
  ChevronDown,
  ChevronUp,
  FileDiff,
  Undo2,
  X,
} from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import type { TurnFileChangesSummary } from "@wegent/chat-core/runtime";
import { useConversationTranslation } from "./ConversationTranslation";
import { useCollaborationPortalTheme } from "../theme/CollaborationTheme";
import { Button } from "../markdown/Button";
import { useEscapeKey } from "../markdown/useEscapeKey";
import {
  FileChangeRow,
  FileChangeSummaryTrigger,
  FileChangesStats,
} from "./FileChangesPreview";
const DEFAULT_VISIBLE_FILE_COUNT = 3;
interface FileChangesCardProps {
  subtaskId: string;
  summary: TurnFileChangesSummary;
  deviceOnline: boolean;
  diffPreviewDisabled?: boolean;
  onLoadDiff: (
    subtaskId: string,
    fileChanges: TurnFileChangesSummary,
  ) => Promise<string>;
  onRevert: (
    subtaskId: string,
    fileChanges: TurnFileChangesSummary,
  ) => Promise<TurnFileChangesSummary>;
  onOpenReview?: (request: {
    subtaskId: string;
    loadDiff: () => Promise<string>;
    reviewTitle?: string;
    defaultFileTreeVisible?: boolean;
    focusFilePath?: string;
  }) => void;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  return fallback;
}

export function FileChangesCard({
  subtaskId,
  summary,
  deviceOnline,
  diffPreviewDisabled,
  onLoadDiff,
  onRevert,
  onOpenReview,
}: FileChangesCardProps) {
  const { t } = useConversationTranslation();
  const [expanded, setExpanded] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const hiddenCount = Math.max(
    0,
    summary.files.length - DEFAULT_VISIBLE_FILE_COUNT,
  );
  const visibleFiles = expanded
    ? summary.files
    : summary.files.slice(0, DEFAULT_VISIBLE_FILE_COUNT);
  const singleFile = summary.files.length === 1 ? summary.files[0] : undefined;
  const shownFileCount = summary.file_count || summary.files.length;
  const actionsDisabled =
    !deviceOnline || summary.status === "artifact_missing";
  const reviewDisabled = actionsDisabled || !onOpenReview;
  const showRevert = summary.status === "active";
  const revertDisabled = actionsDisabled || summary.revertible === false;

  const openReview = (focusFilePath?: string) => {
    onOpenReview?.({
      subtaskId,
      loadDiff: () => onLoadDiff(subtaskId, summary),
      reviewTitle: t("file_changes.previous_turn_label"),
      defaultFileTreeVisible: false,
      focusFilePath,
    });
  };

  const revert = async () => {
    setReverting(true);
    setActionError(undefined);
    try {
      await onRevert(subtaskId, summary);
      setConfirmOpen(false);
    } catch (error) {
      setActionError(getErrorMessage(error, t("file_changes.revert_failed")));
      setConfirmOpen(false);
    } finally {
      setReverting(false);
    }
  };

  return (
    <>
      <section
        data-testid="file-changes-card"
        className="mt-3 overflow-visible rounded-xl border border-border bg-surface"
      >
        {summary.status === "conflicted" ? (
          <p className="border-b border-border bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
            {t("file_changes.conflicted")}
          </p>
        ) : null}
        {summary.status === "artifact_missing" ? (
          <p className="border-b border-border bg-surface px-3 py-1.5 text-xs text-text-muted">
            {t("file_changes.artifact_missing")}
          </p>
        ) : null}
        {!deviceOnline ? (
          <p className="border-b border-border bg-surface px-3 py-1.5 text-xs text-text-muted">
            {t("file_changes.device_offline")}
          </p>
        ) : null}
        {actionError ? (
          <p className="border-b border-border bg-red-50 px-3 py-1.5 text-xs text-red-700">
            {actionError}
          </p>
        ) : null}
        <div
          className={[
            "flex min-h-[4.5rem] items-center gap-3 px-4 py-3",
            singleFile ? "" : "border-b border-border/70",
          ].join(" ")}
        >
          {singleFile ? (
            <FileChangeSummaryTrigger
              file={singleFile}
              summary={summary}
              disabled={reviewDisabled}
              diffPreviewDisabled={diffPreviewDisabled}
              onPreview={() => openReview(singleFile.path)}
            />
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-base text-text-secondary">
                <FileDiff className="h-5 w-5" strokeWidth={1.8} />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  data-testid="file-changes-summary-title"
                  className="block truncate text-sm font-semibold leading-5 text-text-primary"
                >
                  {t("file_changes.edited_files", { count: shownFileCount })}
                </span>
                <FileChangesStats
                  additions={summary.additions}
                  deletions={summary.deletions}
                />
              </span>
            </div>
          )}
          <div className="flex shrink-0 items-center gap-2">
            {summary.status === "reverted" ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary">
                <Check className="h-3.5 w-3.5" />
                {t("file_changes.reverted")}
              </span>
            ) : null}
            {showRevert ? (
              <button
                type="button"
                data-testid="revert-file-changes-button"
                disabled={revertDisabled}
                onClick={() => setConfirmOpen(true)}
                className="flex h-8 items-center justify-center gap-1 rounded-lg px-2 text-xs font-medium text-text-primary hover:bg-base disabled:cursor-not-allowed disabled:text-text-muted disabled:opacity-50"
              >
                {t("file_changes.revert")}
                <Undo2 className="h-3.5 w-3.5" />
              </button>
            ) : null}
            <button
              type="button"
              data-testid="review-file-changes-button"
              disabled={reviewDisabled}
              onClick={() => void openReview()}
              className="h-8 rounded-lg border border-border bg-base px-3 text-xs font-medium text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("file_changes.review")}
            </button>
          </div>
        </div>
        {singleFile ? null : (
          <div className="divide-y divide-border/70">
            {visibleFiles.map((file) => (
              <FileChangeRow
                key={`${file.old_path ?? ""}:${file.path}`}
                file={file}
                summary={summary}
                disabled={reviewDisabled}
                diffPreviewDisabled={diffPreviewDisabled}
                onPreview={() => openReview(file.path)}
              />
            ))}
          </div>
        )}
        {!singleFile && hiddenCount > 0 ? (
          <button
            type="button"
            data-testid="toggle-file-changes-button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="flex h-8 w-full items-center gap-1 px-4 text-xs font-medium text-text-secondary hover:bg-muted"
          >
            <span>
              {expanded
                ? t("file_changes.show_less")
                : t("file_changes.show_more", { count: hiddenCount })}
            </span>
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>
        ) : null}
      </section>
      <ConfirmRevertDialog
        open={confirmOpen}
        submitting={reverting}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => void revert()}
      />
    </>
  );
}

function ConfirmRevertDialog({
  open,
  submitting,
  onClose,
  onConfirm,
}: {
  open: boolean;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useConversationTranslation();
  const portalTheme = useCollaborationPortalTheme();
  useEscapeKey(onClose, open && !submitting);

  if (!open) return null;

  return createPortal(
    <div
      {...portalTheme}
      className={`fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4 ${portalTheme.className}`}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-revert-file-changes-title"
        className="w-full max-w-md rounded-xl border border-border bg-background p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="confirm-revert-file-changes-title"
              className="text-base font-semibold text-text-primary"
            >
              {t("file_changes.confirm_revert_title")}
            </h2>
            <p className="mt-2 text-sm leading-6 text-text-secondary">
              {t("file_changes.confirm_revert_description")}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-md text-text-muted hover:bg-muted"
            data-testid="close-revert-file-changes-button"
            aria-label={t("file_changes.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="primary"
            data-testid="cancel-revert-file-changes-button"
            onClick={onClose}
            disabled={submitting}
          >
            {t("file_changes.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            data-testid="confirm-revert-file-changes-button"
            onClick={onConfirm}
            disabled={submitting}
          >
            {submitting
              ? t("file_changes.reverting")
              : t("file_changes.confirm_revert")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
