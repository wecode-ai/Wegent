import { Button, ContextMenu, Host, Menu, RNHostView, Section } from '@expo/ui/swift-ui'
import { accessibilityLabel, buttonStyle, disabled } from '@expo/ui/swift-ui/modifiers'
import type { ConversationMenuNativeProps } from './ConversationMenuNative.types'

export function ConversationMenuNative(props: ConversationMenuNativeProps) {
  const row = props.trigger === 'longPress'
  const trigger = (
    <RNHostView matchContents={row ? { vertical: true } : true}>
      {typeof props.children === 'function'
        ? props.children({ disabled: props.disabled })
        : props.children}
    </RNHostView>
  )
  const items = [...new Set(props.actions.map(action => action.section))].map(section => (
    <Section key={section} title={section === 'conversation' ? props.title : undefined}>
      {props.actions
        .filter(action => action.section === section)
        .map(action => (
          <Button
            key={action.id}
            label={action.title}
            modifiers={[disabled(action.disabled)]}
            onPress={() => {
              if (!props.disabled && !action.disabled) props.onSelect(action.id)
            }}
            role={action.destructive ? 'destructive' : undefined}
            systemImage={action.icon}
            testID={action.id}
          />
        ))}
    </Section>
  ))
  return (
    <Host
      colorScheme={props.colorScheme}
      ignoreSafeArea="all"
      matchContents={row ? { vertical: true } : true}
      style={
        row ? { width: '100%', minHeight: 48 } : { width: props.width, height: props.height ?? 44 }
      }
      testID={props.testID ?? 'conversation-menu'}
    >
      {row ? (
        <ContextMenu modifiers={[disabled(props.disabled)]} testID={props.triggerTestID}>
          <ContextMenu.Trigger>{trigger}</ContextMenu.Trigger>
          <ContextMenu.Items>{items}</ContextMenu.Items>
        </ContextMenu>
      ) : (
        <Menu
          label={trigger}
          modifiers={[
            buttonStyle('plain'),
            accessibilityLabel(props.accessibilityLabel ?? '更多'),
            disabled(props.disabled),
          ]}
          testID={props.triggerTestID ?? 'more-actions'}
        >
          {items}
        </Menu>
      )}
    </Host>
  )
}
