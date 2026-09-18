import { useEffect, useRef, useState } from "react";
import type { PluginReference } from "@wegent/chat-core/plugin-reference";
import { ComposerTextInput } from "../composer/ComposerTextInput";
import type { ComposerEditorServices } from "../composer/ComposerEditorServices";
import type { ComposerTransferServices } from "../composer/useComposerTransfers";
import { useConversationTranslation } from "./ConversationTranslation";

export function UserMessageEditForm({
  editorServices,
  transferServices,
  onOpenMentionPlugin,
  initialContent,
  submitting,
  onCancel,
  onSubmit,
}: {
  editorServices?: ComposerEditorServices;
  transferServices?: ComposerTransferServices;
  onOpenMentionPlugin?: (reference: PluginReference) => void;
  initialContent: string;
  submitting: boolean;
  onCancel?: () => void;
  onSubmit?: (content: string) => Promise<boolean | void> | boolean | void;
}) {
  const { t } = useConversationTranslation();
  const [draft, setDraft] = useState(initialContent);
  const textareaRef = useRef<HTMLElement | null>(null);
  const trimmedDraft = draft.trim();
  const submitDisabled = submitting || trimmedDraft.length === 0;

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = () => {
    if (submitDisabled) return;
    void onSubmit?.(trimmedDraft);
  };

  return (
    <div
      data-testid="edit-user-message-form"
      className="w-[min(560px,80vw)] max-w-full rounded-2xl bg-muted px-3 py-2 text-base leading-5 text-text-primary"
    >
      <ComposerTextInput
        editorServices={editorServices}
        transferServices={transferServices}
        onOpenMentionPlugin={onOpenMentionPlugin}
        textareaRef={textareaRef}
        testId="edit-user-message-textarea"
        value={draft}
        onChange={setDraft}
        onSubmit={(value) => {
          if (!submitting && value.trim()) void onSubmit?.(value.trim());
        }}
        canSend={trimmedDraft.length > 0}
        disabled={submitting}
        placeholder=""
        rows={2}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel?.();
            return true;
          }
          return false;
        }}
        className="max-h-[280px] min-h-24 w-full overflow-y-auto rounded-xl border border-border bg-base px-3 py-2 text-base leading-5 text-text-primary outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-wait disabled:opacity-70"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          data-testid="cancel-edit-user-message-button"
          disabled={submitting}
          onClick={onCancel}
          className="flex h-8 items-center justify-center rounded-md px-3 text-base font-medium text-text-secondary hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t("message_edit.cancel")}
        </button>
        <button
          type="button"
          data-testid="submit-edit-user-message-button"
          disabled={submitDisabled}
          onClick={submit}
          className="flex h-8 items-center justify-center rounded-md bg-primary px-3 text-base font-medium text-primary-contrast hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t("message_edit.send")}
        </button>
      </div>
    </div>
  );
}
