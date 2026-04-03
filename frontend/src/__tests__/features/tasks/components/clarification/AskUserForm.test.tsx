// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, fireEvent, act } from '@testing-library/react'
import AskUserForm from '@/features/tasks/components/clarification/AskUserForm'
import type { AskUserFormData } from '@/types/api'

// Mock the translation hook
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'ask_user_question.title': 'Question',
        'ask_user_question.recommended': 'Recommended',
        'ask_user_question.submit': 'Submit Answer',
        'ask_user_question.required_field': 'This field is required',
        'ask_user_question.text_placeholder': 'Enter your answer...',
        'ask_user_question.custom_input': 'Custom Input',
        'ask_user_question.custom_placeholder': 'Enter custom input...',
        'clarification.back_to_choices': 'Back to choices',
        'chat:clarification.recommended': 'Recommended',
      }
      return translations[key] || key
    },
  }),
}))

// Mock ChatStreamContext
jest.mock('@/features/tasks/contexts/chatStreamContext', () => ({
  ChatStreamContext: {
    Provider: ({ children }: { children: React.ReactNode }) => children,
  },
}))

// Mock useTaskStateMachine hook
jest.mock('@/features/tasks/hooks/useTaskStateMachine', () => ({
  useTaskStateMachine: () => ({
    messages: new Map(),
  }),
}))

describe('AskUserForm', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  const createMockData = (overrides: Partial<AskUserFormData> = {}): AskUserFormData => ({
    type: 'interactive_form_question',
    ask_id: 'ask_test123',
    task_id: 1,
    subtask_id: 2,
    question: 'Which programming language do you prefer?',
    description: 'Please select your preferred language',
    options: [
      { label: 'Python', value: 'python', recommended: true },
      { label: 'JavaScript', value: 'javascript' },
      { label: 'Go', value: 'go' },
    ],
    multi_select: false,
    input_type: 'choice',
    placeholder: null,
    required: true,
    default: null,
    ...overrides,
  })

  it('renders question and description', () => {
    const data = createMockData()
    render(<AskUserForm data={data} taskId={1} currentMessageIndex={0} />)

    expect(screen.getByText('Which programming language do you prefer?')).toBeInTheDocument()
    expect(screen.getByText('Please select your preferred language')).toBeInTheDocument()
  })

  it('renders single choice options with radio buttons', () => {
    const data = createMockData()
    render(<AskUserForm data={data} taskId={1} currentMessageIndex={0} />)

    expect(screen.getByText('Python')).toBeInTheDocument()
    expect(screen.getByText('JavaScript')).toBeInTheDocument()
    expect(screen.getByText('Go')).toBeInTheDocument()
    expect(screen.getByText('(Recommended)')).toBeInTheDocument()
  })

  it('renders multiple choice options with checkboxes', () => {
    const data = createMockData({ multi_select: true })
    render(<AskUserForm data={data} taskId={1} currentMessageIndex={0} />)

    const checkboxes = screen.getAllByRole('checkbox')
    expect(checkboxes.length).toBe(3)
  })

  it('renders text input when input_type is text', () => {
    const data = createMockData({
      input_type: 'text',
      options: null,
      placeholder: 'Enter your name...',
    })
    render(<AskUserForm data={data} taskId={1} currentMessageIndex={0} />)

    expect(screen.getByPlaceholderText('Enter your name...')).toBeInTheDocument()
  })

  it('auto-selects recommended option', () => {
    const data = createMockData()
    render(<AskUserForm data={data} taskId={1} currentMessageIndex={0} />)

    const pythonRadio = screen.getByRole('radio', { name: /Python/i })
    expect(pythonRadio).toBeChecked()
  })

  it('calls onSubmit with formatted label for single choice', async () => {
    const mockOnSubmit = jest.fn()
    const data = createMockData()
    render(<AskUserForm data={data} taskId={1} currentMessageIndex={0} onSubmit={mockOnSubmit} />)

    const jsRadio = screen.getByRole('radio', { name: /JavaScript/i })
    await act(async () => {
      fireEvent.click(jsRadio)
    })

    const submitButton = screen.getByTestId('ask-user-submit')
    await act(async () => {
      fireEvent.click(submitButton)
    })

    // onSubmit receives (askId, formattedMessage) — structured markdown for ClarificationAnswerSummary
    expect(mockOnSubmit).toHaveBeenCalledWith(
      'ask_test123',
      '## 📝 我的回答 (My Answers)\n\n### ASK_TEST123: Which programming language do you prefer?\n**Answer**: `javascript` - JavaScript\n\n'
    )
  })

  it('calls onSubmit with formatted labels for multiple choice', async () => {
    const mockOnSubmit = jest.fn()
    const data = createMockData({
      multi_select: true,
      default: null,
      options: [
        { label: 'Python', value: 'python' },
        { label: 'JavaScript', value: 'javascript' },
        { label: 'Go', value: 'go' },
      ],
    })
    render(<AskUserForm data={data} taskId={1} currentMessageIndex={0} onSubmit={mockOnSubmit} />)

    const pythonCheckbox = screen.getByRole('checkbox', { name: /Python/i })
    const goCheckbox = screen.getByRole('checkbox', { name: /Go/i })

    await act(async () => {
      fireEvent.click(pythonCheckbox)
    })
    await act(async () => {
      fireEvent.click(goCheckbox)
    })

    const submitButton = screen.getByTestId('ask-user-submit')
    await act(async () => {
      fireEvent.click(submitButton)
    })

    // onSubmit receives structured markdown with multiple values as a list
    expect(mockOnSubmit).toHaveBeenCalledWith(
      'ask_test123',
      '## 📝 我的回答 (My Answers)\n\n### ASK_TEST123: Which programming language do you prefer?\n**Answer**: \n- `python` - Python\n- `go` - Go\n\n'
    )
  })

  it('calls onSubmit with text value for text input', async () => {
    const mockOnSubmit = jest.fn()
    const data = createMockData({
      input_type: 'text',
      options: null,
    })
    render(<AskUserForm data={data} taskId={1} currentMessageIndex={0} onSubmit={mockOnSubmit} />)

    // testid includes question.id which is ask_id for single-question mode
    const textarea = screen.getByTestId('ask-user-textarea-ask_test123')
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'My custom answer' } })
    })

    const submitButton = screen.getByTestId('ask-user-submit')
    await act(async () => {
      fireEvent.click(submitButton)
    })

    expect(mockOnSubmit).toHaveBeenCalledWith(
      'ask_test123',
      '## 📝 我的回答 (My Answers)\n\n### ASK_TEST123: Which programming language do you prefer?\n**Answer**: My custom answer\n\n'
    )
  })

  it('shows inline validation error when required field is empty', async () => {
    const mockOnSubmit = jest.fn()
    const data = createMockData({
      input_type: 'text',
      options: null,
      required: true,
    })
    render(<AskUserForm data={data} taskId={1} currentMessageIndex={0} onSubmit={mockOnSubmit} />)

    const submitButton = screen.getByTestId('ask-user-submit')
    await act(async () => {
      fireEvent.click(submitButton)
    })

    // Inline error shown via data-testid, not toast
    expect(screen.getByTestId('ask-user-error-ask_test123')).toBeInTheDocument()
    expect(screen.getByText('This field is required')).toBeInTheDocument()
    expect(mockOnSubmit).not.toHaveBeenCalled()
  })

  it('renders with default values pre-selected', () => {
    const data = createMockData({
      multi_select: true,
      default: ['python', 'go'],
    })
    render(<AskUserForm data={data} taskId={1} currentMessageIndex={0} />)

    const pythonCheckbox = screen.getByRole('checkbox', { name: /Python/i })
    const goCheckbox = screen.getByRole('checkbox', { name: /Go/i })
    const jsCheckbox = screen.getByRole('checkbox', { name: /JavaScript/i })

    expect(pythonCheckbox).toBeChecked()
    expect(goCheckbox).toBeChecked()
    expect(jsCheckbox).not.toBeChecked()
  })

  it('renders title with chat icon', () => {
    const data = createMockData()
    render(<AskUserForm data={data} taskId={1} currentMessageIndex={0} />)

    expect(screen.getByText('💬')).toBeInTheDocument()
    expect(screen.getByText('Question')).toBeInTheDocument()
  })

  it('has correct data-testid attributes', () => {
    const data = createMockData()
    render(<AskUserForm data={data} taskId={1} currentMessageIndex={0} />)

    expect(screen.getByTestId('ask-user-form')).toBeInTheDocument()
    expect(screen.getByTestId('ask-user-submit')).toBeInTheDocument()
    // option testids include question.id (ask_id) and index
    expect(screen.getByTestId('ask-user-option-ask_test123-0')).toBeInTheDocument()
    expect(screen.getByTestId('ask-user-option-ask_test123-1')).toBeInTheDocument()
    expect(screen.getByTestId('ask-user-option-ask_test123-2')).toBeInTheDocument()
  })

  it('shows custom input toggle button for choice questions', () => {
    const data = createMockData()
    render(<AskUserForm data={data} taskId={1} currentMessageIndex={0} />)

    expect(screen.getByTestId('ask-user-toggle-custom-ask_test123')).toBeInTheDocument()
    expect(screen.getByText('Custom Input')).toBeInTheDocument()
  })

  it('switches to custom textarea when toggle is clicked', async () => {
    const data = createMockData()
    render(<AskUserForm data={data} taskId={1} currentMessageIndex={0} />)

    const toggleButton = screen.getByTestId('ask-user-toggle-custom-ask_test123')
    await act(async () => {
      fireEvent.click(toggleButton)
    })

    expect(screen.getByTestId('ask-user-custom-textarea-ask_test123')).toBeInTheDocument()
    expect(screen.getByText('Back to choices')).toBeInTheDocument()
  })

  it('calls onSubmit with custom text when in custom mode', async () => {
    const mockOnSubmit = jest.fn()
    const data = createMockData()
    render(<AskUserForm data={data} taskId={1} currentMessageIndex={0} onSubmit={mockOnSubmit} />)

    // Switch to custom mode
    const toggleButton = screen.getByTestId('ask-user-toggle-custom-ask_test123')
    await act(async () => {
      fireEvent.click(toggleButton)
    })

    // Type custom text
    const customTextarea = screen.getByTestId('ask-user-custom-textarea-ask_test123')
    await act(async () => {
      fireEvent.change(customTextarea, { target: { value: 'My custom preference' } })
    })

    const submitButton = screen.getByTestId('ask-user-submit')
    await act(async () => {
      fireEvent.click(submitButton)
    })

    expect(mockOnSubmit).toHaveBeenCalledWith(
      'ask_test123',
      '## 📝 我的回答 (My Answers)\n\n### ASK_TEST123: Which programming language do you prefer?\n**Answer**: My custom preference\n\n'
    )
  })
})
