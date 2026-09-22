import { Paperclip, SlidersHorizontal } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type {
  IssueMentionGroup,
  IssueMentionOption,
} from "./issueCommentMentions";
import { IssueCommentComposer } from "./IssueActivityPresentation";
import { IssueMentionPopup } from "./IssueMentionPopup";
import { useIssueCommentMentions } from "./useIssueCommentMentions";

export type { IssueMentionGroup } from "./issueCommentMentions";

export interface IssueMainCommentTestIds {
  form: string;
  input: string;
  send: string;
  settings: string;
  file: string;
  attach: string;
  mentions: string;
}

const desktopTestIds: IssueMainCommentTestIds = {
  form: "task-comment-form",
  input: "cloud-task-activity-composer",
  send: "send-message-button",
  settings: "task-comment-settings-toggle",
  file: "task-comment-file-input",
  attach: "task-comment-attach",
  mentions: "task-comment-mention-popup",
};

/** One desktop composer; hosts provide draft persistence and execution services. */
export function IssueMainCommentComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  sending,
  uploading,
  error,
  sendKey = "enter",
  labels,
  attachments,
  onSelectFiles,
  settings,
  mentionGroups = [],
  testIds = desktopTestIds,
}: {
  value: string;
  onChange(value: string): void;
  /** The structured targets still present in the draft being submitted. */
  onSubmit(mentions: IssueMentionOption[]): void;
  disabled: boolean;
  sending: boolean;
  uploading: boolean;
  error?: string | null;
  sendKey?: "enter" | "cmd_enter";
  labels: {
    placeholder: string;
    send: string;
    attach: string;
    settings: string;
  };
  attachments?: ReactNode;
  onSelectFiles?(files: File[]): void | Promise<void>;
  settings?: ReactNode;
  mentionGroups?: IssueMentionGroup[];
  testIds?: IssueMainCommentTestIds;
}) {
  const settingsId = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const mention = useIssueCommentMentions({ mentionGroups });
  const canSend = !disabled && !sending && !uploading && Boolean(value.trim());

  useLayoutEffect(() => {
    if (caret.current === null) return;
    input.current?.focus();
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);

  function changeValue(nextValue: string, selectionStart: number) {
    onChange(nextValue);
    mention.handleChange(nextValue, selectionStart);
  }

  function insertMention(option: IssueMentionOption) {
    const start = input.current?.selectionStart ?? value.length;
    const end = input.current?.selectionEnd ?? start;
    const inserted = mention.insert(option, value, start, end);
    if (!inserted) return;
    caret.current = inserted.cursor;
    onChange(inserted.value);
  }

  function submitComment() {
    onSubmit(mention.submit(value));
  }

  return (
    <IssueCommentComposer
      data-testid={testIds.form}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          mention.close();
      }}
      canSend={canSend}
      onSubmit={submitComment}
      sendLabel={labels.send}
      sendTestId={testIds.send}
      before={attachments}
      input={
        <>
          <textarea
            ref={input}
            data-testid={testIds.input}
            aria-label={labels.placeholder}
            placeholder={labels.placeholder}
            value={value}
            rows={2}
            disabled={disabled || sending}
            onChange={(event) => {
              changeValue(event.target.value, event.target.selectionStart);
            }}
            onKeyUp={(event) =>
              mention.handleCaret(
                event.currentTarget.value,
                event.currentTarget.selectionStart,
              )
            }
            onKeyDown={(event) => {
              if (mention.open) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  mention.moveHighlight(event.key === "ArrowDown" ? 1 : -1);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  const row = mention.highlighted;
                  if (row?.mention) insertMention(row.mention);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  mention.close();
                  return;
                }
              }
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                (sendKey === "enter" || event.metaKey || event.ctrlKey)
              ) {
                event.preventDefault();
                if (canSend) {
                  submitComment();
                }
              }
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (onSelectFiles && files.length) {
                event.preventDefault();
                void onSelectFiles(files);
              }
            }}
          />
          {mention.open ? (
            <IssueMentionPopup
              groups={mention.groups}
              highlightedId={mention.highlighted?.id ?? null}
              testId={testIds.mentions}
              onHighlight={mention.highlight}
              onPick={insertMention}
            />
          ) : null}
        </>
      }
      actions={
        <>
          {settings && (
            <button
              type="button"
              data-testid={testIds.settings}
              aria-label={labels.settings}
              title={labels.settings}
              disabled={!settings || disabled || sending}
              aria-expanded={settingsOpen}
              aria-controls={settingsId}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </button>
          )}
          <span className="flex-1" />
          <input
            ref={fileInput}
            data-testid={testIds.file}
            type="file"
            multiple
            hidden
            disabled={!onSelectFiles || disabled || sending}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              if (files.length) void onSelectFiles?.(files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            data-testid={testIds.attach}
            aria-label={labels.attach}
            title={labels.attach}
            disabled={!onSelectFiles || disabled || sending}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip className="h-4 w-4" />
          </button>
        </>
      }
      after={
        <>
          {settingsOpen && settings ? (
            <div id={settingsId} className="task-detail-comment-settings">
              {settings}
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="task-detail-comment-inline-error">
              {error}
            </p>
          ) : null}
        </>
      }
    />
  );
}
