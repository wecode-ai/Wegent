import { Paperclip, SlidersHorizontal } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IssueCommentComposer } from "./IssueActivityPresentation";

export interface IssueMentionGroup {
  label: string;
  items: { id: string; name: string; avatar?: string; testId?: string }[];
}

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
  onSubmit(): void;
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
  const activeMentionIndexRef = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mentionsOpen, setMentionsOpen] = useState(false);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const canSend = !disabled && !sending && !uploading && Boolean(value.trim());
  const mentionItems = mentionGroups.flatMap((group) => group.items);

  useLayoutEffect(() => {
    if (caret.current === null) return;
    input.current?.focus();
    input.current?.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);

  function insertMention(name: string) {
    const start = input.current?.selectionStart ?? value.length;
    const end = input.current?.selectionEnd ?? start;
    const rawPrefix = value.slice(0, start);
    const prefix = rawPrefix.endsWith("@") ? rawPrefix.slice(0, -1) : rawPrefix;
    const suffix = value.slice(end);
    const leading = prefix && !/\s$/.test(prefix) ? " " : "";
    const trailing = suffix && /^\s/.test(suffix) ? "" : " ";
    const insertion = `${prefix}${leading}@${name}${trailing}`;
    caret.current = insertion.length;
    onChange(`${insertion}${suffix}`);
    setMentionsOpen(false);
  }

  function setActiveMention(index: number) {
    activeMentionIndexRef.current = index;
    setActiveMentionIndex(index);
  }

  function openMentions() {
    setActiveMention(0);
    setMentionsOpen(true);
  }

  function selectActiveMention() {
    const item = mentionItems[activeMentionIndexRef.current] ?? mentionItems[0];
    if (!item) return false;
    insertMention(item.name);
    return true;
  }

  function moveActiveMention(delta: number) {
    if (!mentionItems.length) return;
    setActiveMention(
      (activeMentionIndexRef.current + delta + mentionItems.length) %
        mentionItems.length,
    );
  }

  return (
    <IssueCommentComposer
      data-testid={testIds.form}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setMentionsOpen(false);
      }}
      canSend={canSend}
      onSubmit={() => {
        setMentionsOpen(false);
        onSubmit();
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
                openMentions();
              } else {
                setMentionsOpen(false);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && mentionsOpen) {
                event.preventDefault();
                event.stopPropagation();
                setMentionsOpen(false);
                return;
              }
              if (
                mentionsOpen &&
                mentionItems.length > 0 &&
                event.key === "ArrowDown"
              ) {
                event.preventDefault();
                moveActiveMention(1);
                return;
              }
              if (
                mentionsOpen &&
                mentionItems.length > 0 &&
                event.key === "ArrowUp"
              ) {
                event.preventDefault();
                moveActiveMention(-1);
                return;
              }
              if (
                mentionsOpen &&
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
                  setMentionsOpen(false);
                  onSubmit();
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
          {mentionsOpen && mentionGroups.some((group) => group.items.length) ? (
            <div className="issue-comment-mention">
              <div
                className="issue-comment-mention-popup"
                data-testid={testIds.mentions}
              >
                {mentionGroups
                  .filter((group) => group.items.length)
                  .map((group) => {
                    const groupStart = mentionItems.findIndex(
                      (item) => item === group.items[0],
                    );
                    return (
                      <section key={group.label}>
                        <h4>{group.label}</h4>
                        {group.items.map((item, itemIndex) => {
                          const flatIndex = groupStart + itemIndex;
                          const active = flatIndex === activeMentionIndex;
                          return (
                            <button
                              type="button"
                              key={item.id}
                              data-testid={
                                item.testId ??
                                `issue-comment-mention-${item.id}`
                              }
                              data-active={active ? "true" : "false"}
                              aria-selected={active}
                              onMouseEnter={() => setActiveMention(flatIndex)}
                              onClick={() => insertMention(item.name)}
                            >
                              <span>
                                {item.avatar ?? item.name.slice(0, 1)}
                              </span>
                              {item.name}
                            </button>
                          );
                        })}
                      </section>
                    );
                  })}
              </div>
            </div>
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
