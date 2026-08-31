import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
} from 'react'
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  TextInput as NativeTextInput,
  type TextInputProps,
} from 'react-native'
import { TextInput as PaperTextInput } from 'react-native-paper'

const KeyboardSafeContext = createContext(false)

type KeyboardSafeViewProps = Omit<
  ComponentProps<typeof KeyboardAvoidingView>,
  'behavior' | 'keyboardVerticalOffset'
>

export type KeyboardSafeTextInputHandle = NativeTextInput

export function KeyboardSafeView(props: KeyboardSafeViewProps) {
  return (
    <KeyboardSafeContext.Provider value>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'height' : undefined}
        keyboardVerticalOffset={0}
        {...props}
      />
    </KeyboardSafeContext.Provider>
  )
}

export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(() => Keyboard.isVisible())

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const showSubscription = Keyboard.addListener(showEvent, () => setVisible(true))
    const hideSubscription = Keyboard.addListener(hideEvent, () => setVisible(false))
    return () => {
      showSubscription.remove()
      hideSubscription.remove()
    }
  }, [])

  return visible
}

export const KeyboardSafeTextInput = forwardRef<NativeTextInput, TextInputProps>((props, ref) => {
  useKeyboardSafeContext('KeyboardSafeTextInput')
  return <NativeTextInput ref={ref} {...props} />
})

KeyboardSafeTextInput.displayName = 'KeyboardSafeTextInput'

type KeyboardSafePaperTextInputProps = ComponentProps<typeof PaperTextInput>

export function KeyboardSafePaperTextInput(props: KeyboardSafePaperTextInputProps) {
  useKeyboardSafeContext('KeyboardSafePaperTextInput')
  return <PaperTextInput {...props} />
}

function useKeyboardSafeContext(componentName: string) {
  const safe = useContext(KeyboardSafeContext)
  if (!safe) throw new Error(`${componentName} must be rendered inside KeyboardSafeView`)
}
