import { createContext, useContext, type ReactNode } from "react";

/**
 * Told before a control opens or closes content inside the conversation, so the scroll
 * owner can treat it as a reader action instead of a layout change it has to follow.
 */
type ReaderDisclosureHandler = () => void;

const noopReaderDisclosure: ReaderDisclosureHandler = () => {};

const ReaderDisclosureContext =
  createContext<ReaderDisclosureHandler>(noopReaderDisclosure);

export function ReaderDisclosureProvider({
  onReaderDisclosure,
  children,
}: {
  onReaderDisclosure: ReaderDisclosureHandler;
  children: ReactNode;
}) {
  return (
    <ReaderDisclosureContext.Provider value={onReaderDisclosure}>
      {children}
    </ReaderDisclosureContext.Provider>
  );
}

/**
 * Reports a disclosure the reader opened or closed themselves. Call it before the state
 * change, and the conversation keeps the reader's place instead of following the bottom
 * to the content they just revealed. Outside a conversation surface it does nothing.
 */
export function useReaderDisclosure(): ReaderDisclosureHandler {
  return useContext(ReaderDisclosureContext);
}
