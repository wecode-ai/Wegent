import { createContext, useContext, type ReactNode } from "react";
export interface ToolInteractionServices {
  openProxySettings?: () => void;
  onOutputAction?: (action: "copy" | "open_file") => void;
}
const Context = createContext<ToolInteractionServices>({});
export function ToolInteractionServicesProvider({
  value,
  children,
}: {
  value: ToolInteractionServices;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useToolInteractionServices() {
  return useContext(Context);
}
