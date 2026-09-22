import { Paperclip, SlidersHorizontal } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IssueCommentComposer } from "./IssueActivityPresentation";
import { IssueCommentMentionPopup } from "./IssueCommentMentionPopup";
import { insertIssueMention } from "./issueCommentMentions";
import type {
  IssueMentionGroup,
  IssueMentionOption,
} from "./issueCommentMentions";
import { useIssueMentionPicker } from "./useIssueMentionPicker";

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
  /** The structured targets the submitted draft still mentions. */
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
  const canSend = !disabled && !sending && !uploading && Boolean(value.trim());
  const mention = useIssueMentionPicker(mentionGroups);
  const mentionItems = mention.items;

  useLayoutEffect(() => {
    if (caret.current === null) return;
    input.current?.focus();
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);

  function insertMention(item: IssueMentionGroup["items"][number]) {
    const start = input.current?.selectionStart ?? value.length;
    const end = input.current?.selectionEnd ?? start;
    const inserted = insertIssueMention(value, start, end, item.name);
    caret.current = inserted.caret;
    mention.remember(item.mention);
    onChange(inserted.value);
    mention.closeMenu();
  }

  function selectActiveMention() {
    const item = mention.active();
    if (!item) return false;
    insertMention(item);
    return true;
  }

  return (
    <IssueCommentComposer
      data-testid={testIds.form}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          mention.closeMenu();
      }}
      canSend={canSend}
      onSubmit={() => {
        mention.closeMenu();
        onSubmit(mention.mentionsFor(value));
      }}
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
              onChange(event.target.value);
              if (
                event.target.value
                  .slice(0, event.target.selectionStart)
                  .endsWith("@")
              ) {
                mention.openMenu();
              } else {
                mention.closeMenu();
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && mention.open) {
                event.preventDefault();
                event.stopPropagation();
                mention.closeMenu();
                return;
              }
              if (
                mention.open &&
                mentionItems.length > 0 &&
                event.key === "ArrowDown"
              ) {
                event.preventDefault();
                mention.move(1);
                return;
              }
              if (
                mention.open &&
                mentionItems.length > 0 &&
                event.key === "ArrowUp"
              ) {
                event.preventDefault();
                mention.move(-1);
                return;
              }
              if (
                mention.open &&
                mentionItems.length > 0 &&
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.stopPropagation();
                selectActiveMention();
                return;
              }
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                (sendKey === "enter" || event.metaKey || event.ctrlKey)
              ) {
                event.preventDefault();
                if (canSend) {
                  mention.closeMenu();
                  onSubmit(mention.mentionsFor(value));
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
          {mention.open && mentionItems.length > 0 ? (
            <IssueCommentMentionPopup
              groups={mention.groups}
              items={mentionItems}
              activeIndex={mention.activeIndex}
              testId={testIds.mentions}
              onHover={mention.highlight}
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
