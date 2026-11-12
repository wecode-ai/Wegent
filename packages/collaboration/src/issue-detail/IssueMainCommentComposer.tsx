import {
  Check,
  ChevronDown,
  Paperclip,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
  type ReactNode,
} from "react";
import { ComposerAutocompleteInput } from "../composer/ComposerAutocompleteInput";
import type { ComposerExternalMentionCandidate } from "../composer/composerAutocompleteInputTypes";
import type { ComposerInputHandle } from "../composer/composerInputTypes";
import type { CollaborationTranslate } from "../i18n";
import { IssueCommentComposer } from "./IssueActivityPresentation";
import type { IssueMentionOption } from "./issueCommentMentions";
import { IssueDetailSearchableSelect } from "./IssueDetailControls";
import {
  useCommentAssignment,
  type CommentAssignment,
} from "./useCommentAssignment";
export type { CommentAssignment } from "./useCommentAssignment";

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
  assignment,
  testIds = desktopTestIds,
}: {
  value: string;
  onChange(value: string): void;
  /** The comment body, plus the structured targets it still names. */
  onSubmit(
    body: string,
    mentions: IssueMentionOption[],
  ): void | boolean | Promise<void | boolean>;
  assignment?: CommentAssignment;
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
  const transfer = useCommentAssignment(value, assignment, onSubmit);
  const blocked = disabled || sending || transfer.busy;
  const inlineError = transfer.error || error;
  const errorRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (inlineError) errorRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [inlineError]);
  const canSend =
    !blocked && !uploading && Boolean(value.trim() || transfer.target);
  const sendLabel = transfer.target
    ? translate(value.trim() ? "todo.send_and_assign" : "todo.assign_only")
    : labels.send;
  const submit = (draft: string) => {
    if (canSend) void transfer.submit(draft);
  };

  return (
    <IssueCommentComposer
      data-testid={testIds.form}
      canSend={canSend}
      onSubmit={() => submit(value)}
      sendLabel={sendLabel}
      showSendLabel={Boolean(assignment)}
      sendTestId={testIds.send}
      before={attachments}
      input={
        <>
          <ComposerAutocompleteInput
            ref={inputRef}
            value={value}
            onChange={onChange}
            onSubmit={(nextValue) => submit(nextValue ?? value)}
            canSend={canSend}
            disabled={blocked}
            placeholder={labels.placeholder}
            testId={testIds.input}
            translate={translate}
            className="task-detail-comment-editor"
            rows={2}
            textareaRef={editorRef}
            mentionScope="external"
            externalMentionCandidates={mentionCandidates}
            onActivateMention={
              assignment && !blocked ? transfer.suggestReference : undefined
            }
            sendKey={sendKey}
            onPasteFiles={
              onSelectFiles ? (files) => void onSelectFiles(files) : undefined
            }
          />
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
              disabled={blocked}
              aria-expanded={settingsOpen}
              aria-controls={settingsId}
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <SlidersHorizontal className="h-4 w-4" />
            </button>
          )}
          <input
            ref={fileInput}
            data-testid={testIds.file}
            type="file"
            multiple
            hidden
            disabled={!onSelectFiles || blocked}
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
            disabled={!onSelectFiles || blocked}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip className="h-4 w-4" />
          </button>
          {transfer.suggestion ? (
            <div
              role="group"
              data-testid={`${testIds.form}-assignee-suggestion`}
              aria-label={translate("todo.assignment_suggestion", undefined, {
                name: transfer.suggestion.label,
              })}
              className="inline-flex min-w-0 shrink items-center gap-1 rounded-lg bg-muted px-1 text-sm text-text-secondary"
            >
              <span className="shrink-0 pl-1 text-text-muted">
                {translate("todo.comment_assign_to")}
              </span>
              <span className="min-w-0 truncate px-1">
                {transfer.suggestion.label}
              </span>
              <button
                type="button"
                data-testid={`${testIds.form}-assignee-confirm`}
                aria-label={translate("todo.confirm_assignment")}
                title={translate("todo.confirm_assignment")}
                disabled={blocked || uploading}
                onClick={transfer.acceptSuggestion}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-primary hover:bg-background disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                data-testid={`${testIds.form}-assignee-dismiss`}
                aria-label={translate("todo.dismiss_assignment_suggestion")}
                title={translate("todo.dismiss_assignment_suggestion")}
                disabled={blocked}
                onClick={transfer.dismissSuggestion}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-muted hover:bg-background disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}
          <span className="flex-1" />
          {assignment ? (
            <>
              <IssueDetailSearchableSelect
                testId={`${testIds.form}-assignee`}
                accessibleLabel={translate("todo.comment_assign_to")}
                value={transfer.target}
                onChange={transfer.setTarget}
                disabled={blocked}
                searchPlaceholder={translate("todo.search_assignee")}
                emptyLabel={translate("todo.no_matching_assignee")}
                className="task-detail-comment-assignee"
                triggerContent={
                  <>
                    {transfer.target ? (
                      <span className="truncate">
                        {
                          transfer.options.find(
                            (option) => option.value === transfer.target,
                          )?.label
                        }
                      </span>
                    ) : (
                      <span>{translate("todo.keep_assignee")}</span>
                    )}
                    <ChevronDown className="h-4 w-4 shrink-0" />
                  </>
                }
                options={[
                  { value: "", label: translate("todo.keep_assignee") },
                  ...transfer.options,
                ]}
              />
            </>
          ) : null}
        </>
      }
      after={
        <>
          {settingsOpen && settings ? (
            <div id={settingsId} className="task-detail-comment-settings">
              {settings}
            </div>
          ) : null}
          {inlineError ? (
            <p
              ref={errorRef}
              role="alert"
              className="task-detail-comment-inline-error"
            >
              {inlineError}
            </p>
          ) : null}
        </>
      }
    />
  );
}
