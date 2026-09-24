import { FileText, Loader2, Paperclip, X } from "lucide-react";
import { useRef, useState, type Ref } from "react";
import { ComposerAutocompleteInput } from "../composer/ComposerAutocompleteInput";
import type { ComposerExternalMentionCandidate } from "../composer/composerAutocompleteInputTypes";
import type { ComposerInputHandle } from "../composer/composerInputTypes";
import type { CollaborationTranslate } from "../i18n";
import { IssueInlineCommentComposer } from "./IssueInlineCommentComposer";
import type { IssueMentionOption } from "./issueCommentMentions";
import { issueCommentSubmission } from "./issueCommentMentions";

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
  mentionCandidates = [],
  translate,
  inputRef,
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
  mentionCandidates?: ComposerExternalMentionCandidate[];
  translate: CollaborationTranslate;
  /** Lets a host (or a test) drive the editor the draft is written in. */
  inputRef?: Ref<ComposerInputHandle>;
  testIds?: IssueReplyTestIds;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const submittingRef = useRef(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const attachmentReady = attachments?.isAttachmentReadyToSend ?? true;

  async function submit(nextDraft = draft) {
    const { body, mentions } = issueCommentSubmission(nextDraft);
    if (!body || disabled || submittingRef.current) return;
    if (!attachmentReady) {
      setError(labels.uploading);
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onSend(body, mentions);
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
        <ComposerAutocompleteInput
          ref={inputRef}
          value={draft}
          onChange={setDraft}
          onSubmit={(nextValue) => void submit(nextValue ?? draft)}
          canSend={
            !disabled && !submitting && Boolean(draft.trim()) && attachmentReady
          }
          disabled={disabled || submitting}
          testId={testIds.input}
          translate={translate}
          className=""
          rows={1}
          textareaRef={editorRef}
          mentionScope="external"
          externalMentionCandidates={mentionCandidates}
          onPasteFiles={
            attachments
              ? (files) => void attachments.handleFileSelect(files)
              : undefined
          }
          placeholder={labels.placeholder}
        />
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
