import { useMemo } from "react";
import { ConversationTranslationProvider } from "../conversation/ConversationTranslation";
import { ScrollableMessageArea } from "../conversation/ScrollableMessageArea";
import type { UserMessageServices } from "../conversation/UserMessage";
import { createCollaborationTranslator } from "../i18n";
import type { WorkspaceProjectManagerRun } from "../ports/SharedWorkspaceApi";
import {
  projectManagerConversationMessages,
  projectManagerFallbackMessages,
} from "./projectManagerConversationMessages";

const userMessageServices: UserMessageServices = {
  images: {
    identity: (attachment) => String(attachment.id),
    async load() {
      throw new Error(
        "Project manager run summaries do not contain attachments",
      );
    },
    async download() {
      throw new Error(
        "Project manager run summaries do not contain attachments",
      );
    },
  },
};

export function ProjectManagerConversation({
  runs,
  locale,
}: {
  runs: WorkspaceProjectManagerRun[];
  locale: "zh-CN" | "en";
}) {
  const activeRun = runs.at(-1);
  const messages = useMemo(
    () =>
      projectManagerConversationMessages(
        projectManagerFallbackMessages(runs, locale),
        activeRun,
      ),
    [activeRun, locale, runs],
  );
  const isWaitingForAssistant = messages.some(
    (message) => message.status === "streaming",
  );
  const translate = useMemo(
    () => createCollaborationTranslator(locale),
    [locale],
  );

  return (
    <ConversationTranslationProvider translate={translate}>
      <ScrollableMessageArea
        messages={messages}
        userMessageServices={userMessageServices}
        conversationKey={`project-ai-${activeRun?.id ?? "new"}`}
        isWaitingForAssistant={isWaitingForAssistant}
        initialScrollPosition="latest"
        scrollTestId="project-ai-conversation-history"
        className="!flex-none"
        scrollerClassName="!h-auto max-h-64 overflow-x-hidden"
        virtualize={false}
      />
    </ConversationTranslationProvider>
  );
}
