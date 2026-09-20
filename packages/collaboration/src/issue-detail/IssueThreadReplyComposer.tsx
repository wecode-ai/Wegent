import { FileText, Loader2, Paperclip, X } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { IssueInlineCommentComposer } from "./IssueInlineCommentComposer";
import type { IssueMentionOption } from "./issueCommentMentions";
import type { IssueMentionGroup } from "./IssueMainCommentComposer";
import { useIssueCommentMentions } from "./useIssueCommentMentions";

export interface IssueReplyAttachment {
  id: string | number;
  filename: string;
}

export interface IssueReplyAttachments<
  T extends IssueReplyAttachment = IssueReplyAttachment,
> {
  attachments: T[];
  uploadingFiles: ReadonlyMap<string, { file: File; progress?: number }>;
  errors: ReadonlyMap<string, string>;
  isAttachmentReadyToSend: boolean;
  handleFileSelect(files: File[]): void | Promise<void>;
  removeAttachment(id: T["id"]): void | Promise<void>;
  resetAttachments(): void;
}

export interface IssueReplyLabels {
  placeholder: string;
  send: string;
  attach: string;
  removeAttachment: string;
  uploading: string;
  sendFailed: string;
}

export interface IssueReplyTestIds {
  composer: string;
  input: string;
  send: string;
  attach: string;
  file: string;
  error: string;
}

export function issueReplyTestIds(rootId: string): IssueReplyTestIds {
  return {
    composer: `cloud-task-activity-inline-composer-${rootId}`,
    input: `cloud-task-activity-card-composer-${rootId}`,
    send: `cloud-task-activity-card-send-${rootId}`,
    attach: `cloud-task-activity-card-attach-${rootId}`,
    file: `cloud-task-activity-card-file-${rootId}`,
    error: `cloud-task-activity-card-error-${rootId}`,
  };
}

/** The desktop reply UI; hosts supply attachment storage and send operations. */
export function IssueThreadReplyComposer<T extends IssueReplyAttachment>({
  rootId,
  disabled,
  labels,
  attachments,
  aiError,
  onSend,
  mentionGroups,
  testIds = issueReplyTestIds(rootId),
}: {
  rootId: string;
  disabled: boolean;
  labels: IssueReplyLabels;
  attachments?: IssueReplyAttachments<T>;
  aiError?: string | null;
  onSend(
    text: string,
    mentions: IssueMentionOption[],
  ): Promise<{ ok: boolean; error?: string }>;
  mentionGroups?: IssueMentionGroup[];
  testIds?: IssueReplyTestIds;
}) {
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const submittingRef = useRef(false);
  const caretRef = useRef<number | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [highlightedMentionId, setHighlightedMentionId] = useState<string | null>(
    null,
  );
  const attachmentReady = attachments?.isAttachmentReadyToSend ?? true;
  const mention = useIssueCommentMentions({ mentionGroups });
  const mentionRows = mention.groups.flatMap((group) =>
    group.items.map((item) => ({ item })),
  );
  const highlightedIndex = Math.max(
    0,
    mentionRows.findIndex((row) => row.item.id === highlightedMentionId),
  );

  // Restore the caret after inserting a mention so typing continues after it.
  useLayoutEffect(() => {
    const caret = caretRef.current;
    if (caret === null) return;
    caretRef.current = null;
    composerInput.current?.focus();
    composerInput.current?.setSelectionRange(caret, caret);
  }, [draft]);

  function insertMention(itemId: string) {
    const start = composerInput.current?.selectionStart ?? draft.length;
    const end = composerInput.current?.selectionEnd ?? start;
    const inserted = mention.insert(itemId, draft, start, end);
    if (!inserted) return;
    caretRef.current = inserted.cursor;
    setDraft(inserted.value);
  }

  async function submit() {
    const text = draft.trim();
    if (!text || disabled || submittingRef.current) return;
    if (!attachmentReady) {
      setError(labels.uploading);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    const mentions = mention.submit(text);
    try {
      const result = await onSend(text, mentions);
      if (result.ok) {
        setDraft("");
        attachments?.resetAttachments();
      } else setError(result.error ?? labels.sendFailed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : labels.sendFailed);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="task-detail-comment-card-composer">
      {attachments &&
      (attachments.attachments.length > 0 ||
        attachments.uploadingFiles.size > 0) ? (
        <div
          className="mb-1.5 flex flex-wrap gap-1.5"
          data-testid={`cloud-task-activity-card-attachments-${rootId}`}
        >
          {attachments.attachments.map((attachment) => (
            <span
              key={attachment.id}
              data-testid={`cloud-task-activity-card-attachment-${rootId}-${attachment.id}`}
              className="inline-flex h-6 max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs text-text-secondary"
            >
              <FileText className="h-3 w-3 flex-none text-text-muted" />
              <span className="truncate">{attachment.filename}</span>
              <button
                type="button"
                data-testid={`cloud-task-activity-card-remove-${rootId}-${attachment.id}`}
                aria-label={labels.removeAttachment}
                disabled={disabled || submitting}
                onClick={() => void attachments.removeAttachment(attachment.id)}
                className="flex h-4 w-4 flex-none items-center justify-center rounded text-text-muted hover:bg-muted hover:text-text-primary"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          {[...attachments.uploadingFiles].map(([key, { file, progress }]) => (
            <span
              key={key}
              data-testid={`cloud-task-activity-card-uploading-${rootId}-${key}`}
              className="inline-flex h-6 max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 text-xs text-text-muted"
            >
              <Loader2 className="h-3 w-3 flex-none animate-spin" />
              <span className="truncate">{file.name}</span>
              {progress !== undefined ? (
                <span className="flex-none">{Math.round(progress)}%</span>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}
      <IssueInlineCommentComposer
        testId={testIds.composer}
        sendTestId={testIds.send}
        canSend={
          !disabled && !submitting && Boolean(draft.trim()) && attachmentReady
        }
        onSend={() => void submit()}
        sendLabel={labels.send}
      >
        {attachments ? (
          <>
            <button
              type="button"
              data-testid={testIds.attach}
              disabled={disabled || submitting}
              onClick={() => fileInput.current?.click()}
              aria-label={labels.attach}
              className="task-detail-reply-attach"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              data-testid={testIds.file}
              disabled={disabled || submitting}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                if (files.length) void attachments.handleFileSelect(files);
                event.target.value = "";
              }}
            />
          </>
        ) : null}
        <textarea
          ref={composerInput}
          rows={1}
          data-testid={testIds.input}
          value={draft}
          disabled={disabled || submitting}
          aria-expanded={mention.open}
          onChange={(event) => {
            setDraft(event.target.value);
            mention.handleChange(
              event.target.value,
              event.target.selectionStart,
            );
          }}
          onKeyUp={(event) =>
            mention.handleCaret(
              event.currentTarget.value,
              event.currentTarget.selectionStart,
            )
          }
          onBlur={() => mention.close()}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (attachments && files.length) {
              event.preventDefault();
              void attachments.handleFileSelect(files);
            }
          }}
          onKeyDown={(event) => {
            if (mention.open) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const delta = event.key === "ArrowDown" ? 1 : -1;
                const next =
                  (highlightedIndex + delta + mentionRows.length) %
                  mentionRows.length;
                setHighlightedMentionId(mentionRows[next]?.item.id ?? null);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                const row = mentionRows[highlightedIndex] ?? mentionRows[0];
                if (row) insertMention(row.item.id);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                mention.close();
                return;
              }
            }
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={labels.placeholder}
          aria-label={labels.placeholder}
        />
        {mention.open ? (
          <div className="issue-comment-mention">
            <div
              className="issue-comment-mention-popup"
              data-testid={`collaboration-chat-reply-mentions-${rootId}`}
            >
              {mention.groups.map((group) => (
                <section key={group.label}>
                  <h4>{group.label}</h4>
                  {group.items.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      data-testid={
                        item.testId ?? `issue-comment-mention-${item.id}`
                      }
                      aria-selected={
                        item.id ===
                        (mentionRows[highlightedIndex]?.item.id ?? null)
                      }
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => item.mention && insertMention(item.id)}
                    >
                      <span>{item.avatar ?? item.name.slice(0, 1)}</span>
                      {item.name}
                    </button>
                  ))}
                </section>
              ))}
            </div>
          </div>
        ) : null}
      </IssueInlineCommentComposer>
      {attachments && attachments.errors.size > 0 ? (
        <p role="alert" className="task-detail-comment-inline-error">
          {[...attachments.errors.values()].join(" · ")}
        </p>
      ) : null}
      {(error ?? aiError) ? (
        <p
          role="alert"
          className="task-detail-comment-inline-error"
          data-testid={testIds.error}
        >
          {error ?? aiError}
        </p>
      ) : null}
    </div>
  );
}
