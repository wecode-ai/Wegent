import { createContext } from "react";

export const IssueConversationDrawerContext = createContext<{
  expanded: boolean;
  toggleExpanded(): void;
} | null>(null);
