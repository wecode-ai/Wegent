import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  type ComponentType,
  type ReactNode,
} from "react";
import {
  normalizeAutomationLocale,
  translateAutomationMessage,
  type AutomationMessageValues,
  type AutomationUiLocale,
} from "./messages";

export interface AutomationUiTranslation {
  t: (...args: any[]) => any;
}

export interface AutomationUiHost {
  useTranslation: (namespace: string) => AutomationUiTranslation;
  locale?: AutomationUiLocale | string;
  PopupMenu: ComponentType<any>;
  Tooltip: ComponentType<any>;
  EventSubscriptionPicker: ComponentType<any>;
}

const AutomationUiHostContext = createContext<AutomationUiHost | null>(null);
const AutomationUiLocaleContext = createContext<AutomationUiLocale>("zh-CN");

export function AutomationUiHostProvider({
  host,
  children,
  locale,
}: {
  host: AutomationUiHost;
  children: ReactNode;
  locale?: AutomationUiLocale | string;
}) {
  const resolvedLocale = normalizeAutomationLocale(locale ?? host.locale);
  return (
    <AutomationUiLocaleContext.Provider value={resolvedLocale}>
      <AutomationUiHostContext.Provider value={host}>
        {children}
      </AutomationUiHostContext.Provider>
    </AutomationUiLocaleContext.Provider>
  );
}

function useAutomationUiHost(): AutomationUiHost {
  const host = useContext(AutomationUiHostContext);
  if (!host) {
    throw new Error("AutomationUiHostProvider is required");
  }
  return host;
}

export function useTranslation(namespace: string): AutomationUiTranslation {
  const hostT = useAutomationUiHost().useTranslation(namespace).t;
  const locale = useContext(AutomationUiLocaleContext);
  const t = useCallback(
    (
      key: string,
      valuesOrFallback?: AutomationMessageValues | string,
      interpolationValues?: AutomationMessageValues,
    ) => {
      const values =
        typeof valuesOrFallback === "object"
          ? valuesOrFallback
          : interpolationValues;
      const shared = translateAutomationMessage(locale, key, values);
      const hostResult = hostT(key, valuesOrFallback, interpolationValues);
      if (
        typeof hostResult === "string" &&
        hostResult !== key &&
        hostResult !== valuesOrFallback
      ) {
        return hostResult;
      }
      if (shared !== key) return shared;
      return typeof valuesOrFallback === "string" ? valuesOrFallback : key;
    },
    [hostT, locale],
  );
  return useMemo(() => ({ t }), [t]);
}

export function useAutomationLocale(): AutomationUiLocale {
  return useContext(AutomationUiLocaleContext);
}

export function PopupMenu(props: any) {
  return createElement(useAutomationUiHost().PopupMenu, props);
}

export function Tooltip(props: any) {
  return createElement(useAutomationUiHost().Tooltip, props);
}

export function HostEventSubscriptionPicker(props: any) {
  return createElement(useAutomationUiHost().EventSubscriptionPicker, props);
}
