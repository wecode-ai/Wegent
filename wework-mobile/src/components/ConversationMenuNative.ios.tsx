import { Button, Host, Menu, RNHostView, Section } from '@expo/ui/swift-ui'
import { accessibilityLabel, buttonStyle, disabled } from '@expo/ui/swift-ui/modifiers'
import type { ConversationMenuNativeProps } from './ConversationMenuNative.types'

export function ConversationMenuNative(props: ConversationMenuNativeProps) {
  return (
    <Host
      colorScheme={props.colorScheme}
      ignoreSafeArea="all"
      matchContents
      style={{ width: props.width, height: 44 }}
      testID="conversation-menu"
    >
      <Menu
        label={<RNHostView matchContents>{props.children}</RNHostView>}
        modifiers={[buttonStyle('plain'), accessibilityLabel('更多'), disabled(props.disabled)]}
        testID="more-actions"
      >
        {[...new Set(props.actions.map(action => action.section))].map(section => (
          <Section key={section} title={section === 'conversation' ? props.title : undefined}>
            {props.actions
              .filter(action => action.section === section)
              .map(action => (
                <Button
                  key={action.id}
                  label={action.title}
                  modifiers={[disabled(action.disabled)]}
                  onPress={() => props.onSelect(action.id)}
                  role={action.destructive ? 'destructive' : undefined}
                  systemImage={action.icon}
                  testID={action.id}
                />
              ))}
          </Section>
        ))}
      </Menu>
    </Host>
  )
}
