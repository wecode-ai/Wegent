import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { CollaborationTranslate } from "../i18n";

type ConversationTranslate = (
  key: string,
  options?: Record<string, string | number>,
) => string;
interface ConversationTranslations {
  t: ConversationTranslate;
  translate: CollaborationTranslate;
}
const Context = createContext<ConversationTranslations | null>(null);

export function ConversationTranslationProvider({
  translate,
  children,
}: {
  translate: CollaborationTranslate;
  children: ReactNode;
}) {
  const value = useMemo<ConversationTranslations>(
    () => ({
      t: (key, options) => translate(`conversation.${key}`, undefined, options),
      translate,
    }),
    [translate],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useConversationTranslation() {
  const value = useContext(Context);
  if (!value) throw new Error("ConversationTranslationProvider is required");
  return value;
}
