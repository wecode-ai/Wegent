import {
  DropdownMenu,
  DropdownMenuItem,
  HorizontalDivider,
  Host,
  RNHostView,
  Text,
} from '@expo/ui/jetpack-compose'
import { testID } from '@expo/ui/jetpack-compose/modifiers'
import { Fragment, useState } from 'react'
import { Pressable } from 'react-native'
import { useTheme } from 'react-native-paper'
import type { ConversationMenuNativeProps } from './ConversationMenuNative.types'

export function ConversationMenuNative(props: ConversationMenuNativeProps) {
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  return (
    <Host
      colorScheme={props.colorScheme}
      ignoreSafeAreaKeyboardInsets
      matchContents
      style={{ width: props.width, height: 44 }}
      modifiers={[testID('conversation-menu')]}
    >
      <DropdownMenu
        expanded={expanded}
        onDismissRequest={() => setExpanded(false)}
        properties={{ clippingEnabled: false }}
      >
        <DropdownMenu.Trigger>
          <RNHostView matchContents>
            <Pressable
              accessibilityLabel="更多"
              accessibilityRole="button"
              accessibilityState={{ disabled: props.disabled, expanded }}
              disabled={props.disabled}
              onPress={() => setExpanded(true)}
              testID="more-actions"
            >
              {props.children}
            </Pressable>
          </RNHostView>
        </DropdownMenu.Trigger>
        <DropdownMenu.Items>
          {props.actions.map((action, index) => (
            <Fragment key={action.id}>
              {index > 0 && props.actions[index - 1]?.section !== action.section ? (
                <HorizontalDivider />
              ) : null}
              <DropdownMenuItem
                elementColors={action.destructive ? { textColor: theme.colors.error } : undefined}
                enabled={!action.disabled}
                modifiers={[testID(action.id)]}
                onClick={() => {
                  setExpanded(false)
                  props.onSelect(action.id)
                }}
              >
                <DropdownMenuItem.Text>
                  <Text>{action.title}</Text>
                </DropdownMenuItem.Text>
              </DropdownMenuItem>
            </Fragment>
          ))}
        </DropdownMenu.Items>
      </DropdownMenu>
    </Host>
  )
}
