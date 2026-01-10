// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import '@testing-library/jest-dom'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import GenericForm from '@/features/tasks/components/forms/GenericForm'
import type { FormSchema, FormContext } from '@/types/form'

// Mock translation hook
jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        'form.validation_error': 'Please fill in all required fields',
        'form.submit_success': 'Form submitted successfully',
        'form.submit_failed': 'Failed to submit form',
        'form.submit': 'Submit',
      }
      return translations[key] || key
    },
  }),
}))

// Mock toast hook
const mockToast = jest.fn()
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({
    toast: mockToast,
  }),
}))

// Mock forms API
const mockSubmit = jest.fn()
jest.mock('@/apis/forms', () => ({
  formApis: {
    submit: (request: unknown) => mockSubmit(request),
  },
}))

describe('GenericForm', () => {
  const baseSchema: FormSchema = {
    action_type: 'test_action',
    title: 'Test Form',
    description: 'A test form description',
    fields: [
      {
        field_id: 'name',
        field_type: 'text_input',
        label: 'Name',
        required: true,
        placeholder: 'Enter your name',
      },
      {
        field_id: 'choice',
        field_type: 'single_choice',
        label: 'Select Option',
        required: true,
        options: [
          { value: 'a', label: 'Option A' },
          { value: 'b', label: 'Option B', recommended: true },
        ],
      },
    ],
    submit_label: 'Send',
  }

  const baseContext: FormContext = {
    task_id: 123,
    team_id: 456,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockSubmit.mockResolvedValue({
      submission_id: 'test-uuid',
      status: 'completed',
      message: 'Success',
    })
  })

  it('renders form with title and description', () => {
    render(<GenericForm schema={baseSchema} context={baseContext} />)

    expect(screen.getByText('Test Form')).toBeInTheDocument()
    expect(screen.getByText('A test form description')).toBeInTheDocument()
  })

  it('renders all form fields', () => {
    render(<GenericForm schema={baseSchema} context={baseContext} />)

    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('Select Option')).toBeInTheDocument()
    expect(screen.getByText('Option A')).toBeInTheDocument()
    expect(screen.getByText('Option B')).toBeInTheDocument()
  })

  it('renders submit button with custom label', () => {
    render(<GenericForm schema={baseSchema} context={baseContext} />)

    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument()
  })

  it('shows validation error when required field is empty', async () => {
    render(<GenericForm schema={baseSchema} context={baseContext} />)

    // Click submit without filling required fields
    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Please fill in all required fields',
        })
      )
    })
  })

  it('uses initial values when provided', () => {
    const initialValues = {
      name: 'John Doe',
      choice: 'a',
    }

    render(
      <GenericForm
        schema={baseSchema}
        context={baseContext}
        initialValues={initialValues}
      />
    )

    const nameInput = screen.getByPlaceholderText('Enter your name')
    expect(nameInput).toHaveValue('John Doe')
  })

  it('submits form data correctly', async () => {
    const onSubmitSuccess = jest.fn()

    render(
      <GenericForm
        schema={baseSchema}
        context={baseContext}
        initialValues={{ name: 'Test User', choice: 'a' }}
        onSubmitSuccess={onSubmitSuccess}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => {
      expect(mockSubmit).toHaveBeenCalledWith({
        action_type: 'test_action',
        form_data: expect.objectContaining({
          name: 'Test User',
          choice: 'a',
        }),
        context: baseContext,
      })
    })

    await waitFor(() => {
      expect(onSubmitSuccess).toHaveBeenCalled()
    })
  })

  it('disables form when readonly is true', () => {
    render(<GenericForm schema={baseSchema} context={baseContext} readonly={true} />)

    // Submit button should not be present when readonly
    expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument()
  })

  it('handles submission error', async () => {
    const onSubmitError = jest.fn()
    mockSubmit.mockRejectedValue(new Error('Network error'))

    render(
      <GenericForm
        schema={baseSchema}
        context={baseContext}
        initialValues={{ name: 'Test', choice: 'a' }}
        onSubmitError={onSubmitError}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => {
      expect(onSubmitError).toHaveBeenCalledWith(expect.any(Error))
    })
  })
})

describe('FormFieldRenderer', () => {
  it('renders single choice field correctly', () => {
    const schema: FormSchema = {
      action_type: 'test',
      title: 'Test',
      fields: [
        {
          field_id: 'choice',
          field_type: 'single_choice',
          label: 'Pick one',
          options: [
            { value: 'opt1', label: 'Option 1' },
            { value: 'opt2', label: 'Option 2', recommended: true },
          ],
        },
      ],
    }

    render(<GenericForm schema={schema} context={{}} />)

    expect(screen.getByText('Pick one')).toBeInTheDocument()
    expect(screen.getByText('Option 1')).toBeInTheDocument()
    expect(screen.getByText('Option 2')).toBeInTheDocument()
    expect(screen.getByText('Recommended')).toBeInTheDocument()
  })

  it('renders multiple choice field correctly', () => {
    const schema: FormSchema = {
      action_type: 'test',
      title: 'Test',
      fields: [
        {
          field_id: 'multi',
          field_type: 'multiple_choice',
          label: 'Pick many',
          options: [
            { value: 'm1', label: 'Choice 1' },
            { value: 'm2', label: 'Choice 2' },
          ],
        },
      ],
    }

    render(<GenericForm schema={schema} context={{}} />)

    expect(screen.getByText('Pick many')).toBeInTheDocument()
    expect(screen.getByText('Choice 1')).toBeInTheDocument()
    expect(screen.getByText('Choice 2')).toBeInTheDocument()
  })

  it('renders text input field correctly', () => {
    const schema: FormSchema = {
      action_type: 'test',
      title: 'Test',
      fields: [
        {
          field_id: 'text',
          field_type: 'text_input',
          label: 'Enter text',
          placeholder: 'Type here...',
        },
      ],
    }

    render(<GenericForm schema={schema} context={{}} />)

    expect(screen.getByText('Enter text')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Type here...')).toBeInTheDocument()
  })
})
