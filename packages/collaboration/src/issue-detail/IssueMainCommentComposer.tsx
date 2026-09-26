import { Paperclip, SlidersHorizontal } from "lucide-react";
import { useId, useRef, useState, type Ref, type ReactNode } from "react";
import { ComposerAutocompleteInput } from "../composer/ComposerAutocompleteInput";
import type { ComposerExternalMentionCandidate } from "../composer/composerAutocompleteInputTypes";
import type { ComposerInputHandle } from "../composer/composerInputTypes";
import type { CollaborationTranslate } from "../i18n";
import { IssueCommentComposer } from "./IssueActivityPresentation";
import type { IssueMentionOption } from "./issueCommentMentions";
import { issueCommentSubmission } from "./issueCommentMentions";

export interface IssueMainCommentTestIds {
  form: string;
  input: string;
  send: string;
  settings: string;
  file: string;
  attach: string;
}

const desktopTestIds: IssueMainCommentTestIds = {
  form: "task-comment-form",
  input: "cloud-task-activity-composer",
  send: "send-message-button",
  settings: "task-comment-settings-toggle",
  file: "task-comment-file-input",
  attach: "task-comment-attach",
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
  mentionCandidates = [],
  translate,
  inputRef,
  testIds = desktopTestIds,
}: {
  value: string;
  onChange(value: string): void;
  /** The comment body, plus the structured targets it still names. */
  onSubmit(body: string, mentions: IssueMentionOption[]): void;
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
  mentionCandidates?: ComposerExternalMentionCandidate[];
  translate: CollaborationTranslate;
  /** Lets a host (or a test) drive the editor the draft is written in. */
  inputRef?: Ref<ComposerInputHandle>;
  testIds?: IssueMainCommentTestIds;
}) {
  const settingsId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const canSend = !disabled && !sending && !uploading && Boolean(value.trim());
  const submit = (draft: string) => {
    const { body, mentions } = issueCommentSubmission(draft);
    onSubmit(body, mentions);
  };

  return (
    <IssueCommentComposer
      data-testid={testIds.form}
      canSend={canSend}
      onSubmit={() => submit(value)}
      sendLabel={labels.send}
      sendTestId={testIds.send}
      before={attachments}
      input={
        <ComposerAutocompleteInput
          ref={inputRef}
          value={value}
          onChange={onChange}
          onSubmit={(nextValue) => submit(nextValue ?? value)}
          canSend={canSend}
          disabled={disabled || sending}
          placeholder={labels.placeholder}
          testId={testIds.input}
          translate={translate}
          className="task-detail-comment-editor"
          rows={2}
          textareaRef={editorRef}
          mentionScope="external"
          externalMentionCandidates={mentionCandidates}
          sendKey={sendKey}
          onPasteFiles={
            onSelectFiles ? (files) => void onSelectFiles(files) : undefined
          }
        />
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
