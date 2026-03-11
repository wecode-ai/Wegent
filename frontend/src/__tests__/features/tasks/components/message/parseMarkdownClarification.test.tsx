// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { parseMarkdownClarification } from '@/features/tasks/components/message/parseMarkdownClarification'
import type { ClarificationData } from '@/types/api'

// ============================================================================
// Test Utilities
// ============================================================================

const extract = (content: string): ClarificationData | null => {
  const result = parseMarkdownClarification(content)
  return result ? result.data : null
}

// ============================================================================
// Test Data Definitions
// ============================================================================

interface OptionValueTestCase {
  name: string
  content: string
  expectedOptions: Array<{
    value: string
    label: string
    recommended?: boolean
  }>
}

const optionValueTestCases: OptionValueTestCase[] = [
  {
    name: 'backticks with hyphens (range notation)',
    content: `## Clarification Questions
Q1: Select verification code strength
Type: single_choice
- [✓] \`1-9\` - Low (simple numeric or alphabetic code, 4 digits) (recommended)
- [ ] \`10-99\` - Medium strength
- [ ] \`100-999\` - High strength`,
    expectedOptions: [
      {
        value: '1-9',
        label: 'Low (simple numeric or alphabetic code, 4 digits)',
        recommended: true,
      },
      { value: '10-99', label: 'Medium strength' },
      { value: '100-999', label: 'High strength' },
    ],
  },
  {
    name: 'backticks with range notation (4-6)',
    content: `## Clarification Questions
Q1: Select character length
Type: single_choice
- [✓] \`4-6\` - 4 to 6 characters (balanced security and UX) (recommended)
- [ ] \`6-8\` - 6 to 8 characters
- [ ] \`8-12\` - 8 to 12 characters`,
    expectedOptions: [
      { value: '4-6', label: '4 to 6 characters (balanced security and UX)', recommended: true },
      { value: '6-8', label: '6 to 8 characters' },
      { value: '8-12', label: '8 to 12 characters' },
    ],
  },
  {
    name: 'complex values with dots and versions',
    content: `## Clarification Questions
Q1: Select configuration
Type: single_choice
- [✓] \`config-v1.2.3\` - Version 1.2.3 config (recommended)
- [ ] \`config-v2.0.0-beta\` - Beta version
- [ ] \`config-latest\` - Latest version`,
    expectedOptions: [
      { value: 'config-v1.2.3', label: 'Version 1.2.3 config', recommended: true },
      { value: 'config-v2.0.0-beta', label: 'Beta version' },
      { value: 'config-latest', label: 'Latest version' },
    ],
  },
  {
    name: 'values without backticks',
    content: `## Clarification Questions
Q1: Select option
Type: single_choice
- [✓] option1 - Option 1 (recommended)
- [ ] option2 - Option 2`,
    expectedOptions: [
      { value: 'option1', label: 'Option 1', recommended: true },
      { value: 'option2', label: 'Option 2' },
    ],
  },
  {
    name: 'values with only numbers',
    content: `## Clarification Questions
Q1: Select quantity
Type: single_choice
- [✓] \`1\` - One (recommended)
- [ ] \`2\` - Two
- [ ] \`3\` - Three`,
    expectedOptions: [
      { value: '1', label: 'One', recommended: true },
      { value: '2', label: 'Two' },
      { value: '3', label: 'Three' },
    ],
  },
  {
    name: 'values with underscores',
    content: `## Clarification Questions
Q1: Select mode
Type: single_choice
- [✓] \`mode_a_1\` - Mode A1 (recommended)
- [ ] \`mode_b_2\` - Mode B2`,
    expectedOptions: [
      { value: 'mode_a_1', label: 'Mode A1', recommended: true },
      { value: 'mode_b_2', label: 'Mode B2' },
    ],
  },
  {
    name: 'values with Unicode characters',
    content: `## Clarification Questions
Q1: Select language
Type: single_choice
- [✓] \`中文\` - Chinese interface (recommended)
- [ ] \`English\` - English interface`,
    expectedOptions: [
      { value: '中文', label: 'Chinese interface', recommended: true },
      { value: 'English', label: 'English interface' },
    ],
  },
  {
    name: 'values with dots and versions (semantic versioning)',
    content: `## Clarification Questions
Q1: Select version
Type: single_choice
- [✓] \`v1.2.3-beta.1\` - Beta version (recommended)
- [ ] \`v2.0.0-rc.1\` - RC version
- [ ] \`v1.0.0\` - Stable version`,
    expectedOptions: [
      { value: 'v1.2.3-beta.1', label: 'Beta version', recommended: true },
      { value: 'v2.0.0-rc.1', label: 'RC version' },
      { value: 'v1.0.0', label: 'Stable version' },
    ],
  },
  {
    name: 'values with forward slashes',
    content: `## Clarification Questions
Q1: Select path
Type: single_choice
- [✓] \`src/components/ui\` - UI components (recommended)
- [ ] \`src/lib/utils\` - Utility functions
- [ ] \`src/hooks\` - Custom Hooks`,
    expectedOptions: [
      { value: 'src/components/ui', label: 'UI components', recommended: true },
      { value: 'src/lib/utils', label: 'Utility functions' },
      { value: 'src/hooks', label: 'Custom Hooks' },
    ],
  },
  {
    name: 'values with colons (URLs)',
    content: `## Clarification Questions
Q1: Select protocol
Type: single_choice
- [✓] \`https://\` - HTTPS (recommended)
- [ ] \`http://\` - HTTP
- [ ] \`ws://\` - WebSocket`,
    expectedOptions: [
      { value: 'https://', label: 'HTTPS', recommended: true },
      { value: 'http://', label: 'HTTP' },
      { value: 'ws://', label: 'WebSocket' },
    ],
  },
  {
    name: 'values with @ symbol',
    content: `## Clarification Questions
Q1: Select dependency
Type: single_choice
- [✓] \`@types/react\` - React types (recommended)
- [ ] \`@types/node\` - Node types
- [ ] \`typescript\` - TypeScript`,
    expectedOptions: [
      { value: '@types/react', label: 'React types', recommended: true },
      { value: '@types/node', label: 'Node types' },
      { value: 'typescript', label: 'TypeScript' },
    ],
  },
  {
    name: 'values with emoji',
    content: `## Clarification Questions
Q1: Select priority
Type: single_choice
- [✓] \`🔴 High\` - High priority (recommended)
- [ ] \`🟡 Medium\` - Medium priority
- [ ] \`🟢 Low\` - Low priority`,
    expectedOptions: [
      { value: '🔴 High', label: 'High priority', recommended: true },
      { value: '🟡 Medium', label: 'Medium priority' },
      { value: '🟢 Low', label: 'Low priority' },
    ],
  },
]

interface LabelParsingTestCase {
  name: string
  content: string
  expectedOptions: Array<{
    value: string
    label: string
    recommended?: boolean
  }>
}

const labelParsingTestCases: LabelParsingTestCase[] = [
  {
    name: 'parentheses in the middle of label',
    content: `## Clarification Questions
Q1: Select verification code type
Type: single_choice
- [✓] \`numeric\` - Numeric code (4 digits) recommended for quick verification (recommended)
- [ ] \`alphanumeric\` - Alphanumeric mixed (6 digits)`,
    expectedOptions: [
      {
        value: 'numeric',
        label: 'Numeric code (4 digits) recommended for quick verification',
        recommended: true,
      },
      { value: 'alphanumeric', label: 'Alphanumeric mixed (6 digits)' },
    ],
  },
  {
    name: 'removes (recommended) suffix from label',
    content: `## Clarification Questions
Q1: Select option
Type: single_choice
- [✓] \`opt1\` - Option 1 (recommended)
- [ ] \`opt2\` - Option 2 (Recommended)`,
    expectedOptions: [
      { value: 'opt1', label: 'Option 1', recommended: true },
      { value: 'opt2', label: 'Option 2' },
    ],
  },
  {
    name: 'multiple parentheses in label',
    content: `## Clarification Questions
Q1: Select configuration
Type: single_choice
- [✓] \`config1\` - Config 1 (supports A) (supports B) (recommended)
- [ ] \`config2\` - Config 2 (supports A only)`,
    expectedOptions: [
      { value: 'config1', label: 'Config 1 (supports A) (supports B)', recommended: true },
      { value: 'config2', label: 'Config 2 (supports A only)' },
    ],
  },
  {
    name: 'very long labels',
    content: `## Clarification Questions
Q1: Select option
Type: single_choice
- [✓] \`long\` - This is a very long label text used to test whether the parser can correctly handle long content, including various characters and punctuation marks (such as parentheses, commas, periods, etc.), as well as some additional explanatory information (recommended)
- [ ] \`short\` - Short label`,
    expectedOptions: [
      {
        value: 'long',
        label:
          'This is a very long label text used to test whether the parser can correctly handle long content, including various characters and punctuation marks (such as parentheses, commas, periods, etc.), as well as some additional explanatory information',
        recommended: true,
      },
      { value: 'short', label: 'Short label' },
    ],
  },
]

interface CheckboxMarkerTestCase {
  name: string
  content: string
  expectedRecommended: boolean[]
}

const checkboxMarkerTestCases: CheckboxMarkerTestCase[] = [
  {
    name: 'checkmark (✓) marker',
    content: `## Clarification Questions
Q1: Select option
Type: single_choice
- [✓] \`opt1\` - Option 1
- [ ] \`opt2\` - Option 2`,
    expectedRecommended: [true, false],
  },
  {
    name: 'x/X markers',
    content: `## Clarification Questions
Q1: Select option
Type: single_choice
- [x] \`opt1\` - Option 1
- [X] \`opt2\` - Option 2
- [ ] \`opt3\` - Option 3`,
    expectedRecommended: [true, true, false],
  },
  {
    name: 'asterisk (*) marker',
    content: `## Clarification Questions
Q1: Select option
Type: single_choice
- [*] \`opt1\` - Option 1
- [ ] \`opt2\` - Option 2`,
    expectedRecommended: [true, false],
  },
]

interface FormatVariantTestCase {
  name: string
  content: string
  expectedQuestions: number
  expectedTypes?: string[]
}

const formatVariantTestCases: FormatVariantTestCase[] = [
  {
    name: 'spec-ghost standard format',
    content: `## Clarification Questions

Q1: Does this feature need to support mobile devices?
Type: single_choice
- [✓] \`yes\` - Yes (recommended)
- [ ] \`no\` - No

Q2: What authentication methods should be supported?
Type: multiple_choice
- [✓] \`email\` - Email/Password (recommended)
- [ ] \`oauth\` - OAuth2.0
- [ ] \`sso\` - SSO

Q3: Please describe your special requirements
Type: text_input`,
    expectedQuestions: 3,
    expectedTypes: ['single_choice', 'multiple_choice', 'text_input'],
  },
  {
    name: 'heading format (### Q1:)',
    content: `## 🤔 Clarification Questions

### Q1: Does this feature need to support mobile devices?
**Type**: single_choice
**Options**:
- [✓] \`yes\` - Yes (recommended)
- [ ] \`no\` - No

### Q2: What authentication methods should be supported?
**Type**: multiple_choice
**Options**:
- [✓] \`email\` - Email/Password (recommended)
- [ ] \`oauth\` - OAuth2.0`,
    expectedQuestions: 2,
    expectedTypes: ['single_choice', 'multiple_choice'],
  },
  {
    name: 'bold format (**Q1:**)',
    content: `## Clarification Questions

**Q1:** Does this feature need to support mobile devices?
**Type**: single_choice
- [✓] \`yes\` - Yes (recommended)
- [ ] \`no\` - No

**Q2:** What authentication methods should be supported?
**Type**: multiple_choice
- [✓] \`email\` - Email/Password (recommended)
- [ ] \`oauth\` - OAuth2.0`,
    expectedQuestions: 2,
    expectedTypes: ['single_choice', 'multiple_choice'],
  },
  {
    name: 'Chinese header (💬 智能追问)',
    content: `## 💬 智能追问

Q1: Does this feature need to support mobile devices?
Type: single_choice
- [✓] \`yes\` - Yes (recommended)
- [ ] \`no\` - No`,
    expectedQuestions: 1,
  },
  {
    name: 'Chinese header (🤔 需求澄清问题)',
    content: `## 🤔 需求澄清问题

Q1: Does this feature need to support mobile devices?
Type: single_choice
- [✓] \`yes\` - Yes (recommended)
- [ ] \`no\` - No`,
    expectedQuestions: 1,
  },
  {
    name: 'different heading levels (# to ######)',
    content: `#### Clarification Questions

Q1: Does this feature need to support mobile devices?
Type: single_choice
- [✓] \`yes\` - Yes (recommended)
- [ ] \`no\` - No`,
    expectedQuestions: 1,
  },
]

interface MultiQuestionTestCase {
  name: string
  content: string
  expectedQuestions: number
  expectedOptionsCounts: number[]
}

const multiQuestionTestCases: MultiQuestionTestCase[] = [
  {
    name: '3 questions with different option counts',
    content: `## Clarification Questions

Q1: Select framework
Type: single_choice
- [✓] \`react\` - React (recommended)
- [ ] \`vue\` - Vue
- [ ] \`angular\` - Angular

Q2: Select database
Type: single_choice
- [✓] \`postgresql\` - PostgreSQL (recommended)
- [ ] \`mysql\` - MySQL

Q3: Select deployment
Type: single_choice
- [✓] \`docker\` - Docker (recommended)
- [ ] \`k8s\` - Kubernetes
- [ ] \`bare\` - Bare metal
- [ ] \`serverless\` - Serverless`,
    expectedQuestions: 3,
    expectedOptionsCounts: [3, 2, 4],
  },
  {
    name: '2 questions with mixed types',
    content: `## Clarification Questions

Q1: Select budget range
Type: single_choice
- [✓] \`low\` - Under $10k (recommended)
- [ ] \`medium\` - $10k-$50k
- [ ] \`high\` - Over $50k

Q2: Which expense categories to track?
Type: multiple_choice
- [✓] \`operating\` - Operating costs (recommended)
- [✓] \`personnel\` - Personnel costs
- [ ] \`marketing\` - Marketing costs
- [ ] \`r_and_d\` - R&D costs
- [ ] \`other\` - Other`,
    expectedQuestions: 2,
    expectedOptionsCounts: [3, 5],
  },
]

interface StressTestCase {
  name: string
  content: string
  expectedQuestions: number
  expectedOptionsPerQuestion: number
}

const stressTestCases: StressTestCase[] = [
  {
    name: '12 options in single question',
    content: `## Clarification Questions

Q1: Select programming language
Type: single_choice
- [✓] \`typescript\` - TypeScript (recommended)
- [ ] \`javascript\` - JavaScript
- [ ] \`python\` - Python
- [ ] \`java\` - Java
- [ ] \`go\` - Go
- [ ] \`rust\` - Rust
- [ ] \`cpp\` - C++
- [ ] \`c\` - C
- [ ] \`ruby\` - Ruby
- [ ] \`php\` - PHP
- [ ] \`swift\` - Swift
- [ ] \`kotlin\` - Kotlin`,
    expectedQuestions: 1,
    expectedOptionsPerQuestion: 12,
  },
  {
    name: '6 questions',
    content: `## Clarification Questions

Q1: Question 1?
Type: single_choice
- [✓] \`a\` - A

Q2: Question 2?
Type: single_choice
- [✓] \`b\` - B

Q3: Question 3?
Type: single_choice
- [✓] \`c\` - C

Q4: Question 4?
Type: single_choice
- [✓] \`d\` - D

Q5: Question 5?
Type: single_choice
- [✓] \`e\` - E

Q6: Question 6?
Type: single_choice
- [✓] \`f\` - F`,
    expectedQuestions: 6,
    expectedOptionsPerQuestion: 1,
  },
  {
    name: 'text_input type (no options)',
    content: `## Clarification Questions

Q1: Please describe your special requirements
Type: text_input

Q2: Select authentication method
Type: single_choice
- [✓] \`email\` - Email authentication (recommended)
- [ ] \`phone\` - Phone authentication`,
    expectedQuestions: 2,
    expectedOptionsPerQuestion: 0, // First has 0, second has 2
  },
]

// ============================================================================
// Tests
// ============================================================================

describe('parseMarkdownClarification', () => {
  describe('Option Value Parsing', () => {
    test.each(optionValueTestCases)('should parse $name', ({ content, expectedOptions }) => {
      const data = extract(content)

      expect(data).not.toBeNull()
      expect(data!.questions).toHaveLength(1)
      expect(data!.questions[0].options).toHaveLength(expectedOptions.length)

      expectedOptions.forEach((expected, index) => {
        expect(data!.questions[0].options![index].value).toBe(expected.value)
        expect(data!.questions[0].options![index].label).toBe(expected.label)
        if (expected.recommended !== undefined) {
          expect(data!.questions[0].options![index].recommended).toBe(expected.recommended)
        }
      })
    })
  })

  describe('Label Parsing with Parentheses', () => {
    test.each(labelParsingTestCases)('should handle $name', ({ content, expectedOptions }) => {
      const data = extract(content)

      expect(data).not.toBeNull()
      expect(data!.questions).toHaveLength(1)
      expect(data!.questions[0].options).toHaveLength(expectedOptions.length)

      expectedOptions.forEach((expected, index) => {
        expect(data!.questions[0].options![index].value).toBe(expected.value)
        expect(data!.questions[0].options![index].label).toBe(expected.label)
        if (expected.recommended !== undefined) {
          expect(data!.questions[0].options![index].recommended).toBe(expected.recommended)
        }
      })
    })
  })

  describe('Checkbox Markers', () => {
    test.each(checkboxMarkerTestCases)(
      'should recognize $name',
      ({ content, expectedRecommended }) => {
        const data = extract(content)

        expect(data).not.toBeNull()
        expect(data!.questions).toHaveLength(1)
        expect(data!.questions[0].options).toHaveLength(expectedRecommended.length)

        expectedRecommended.forEach((expected, index) => {
          expect(data!.questions[0].options![index].recommended).toBe(expected)
        })
      }
    )
  })

  describe('Format Variants', () => {
    test.each(formatVariantTestCases)(
      'should parse $name',
      ({ content, expectedQuestions, expectedTypes }) => {
        const data = extract(content)

        expect(data).not.toBeNull()
        expect(data!.questions).toHaveLength(expectedQuestions)

        if (expectedTypes) {
          expectedTypes.forEach((expectedType, index) => {
            expect(data!.questions[index].question_type).toBe(expectedType)
          })
        }
      }
    )
  })

  describe('Multiple Questions', () => {
    test.each(multiQuestionTestCases)(
      'should parse $name',
      ({ content, expectedQuestions, expectedOptionsCounts }) => {
        const data = extract(content)

        expect(data).not.toBeNull()
        expect(data!.questions).toHaveLength(expectedQuestions)

        expectedOptionsCounts.forEach((expectedCount, index) => {
          expect(data!.questions[index].options).toHaveLength(expectedCount)
        })
      }
    )
  })

  describe('Stress Tests', () => {
    test.each(stressTestCases)(
      'should handle $name',
      ({ content, expectedQuestions, expectedOptionsPerQuestion }) => {
        const data = extract(content)

        expect(data).not.toBeNull()
        expect(data!.questions).toHaveLength(expectedQuestions)

        // For text_input test case, check specific counts
        if (expectedOptionsPerQuestion === 0 && expectedQuestions === 2) {
          expect(data!.questions[0].question_type).toBe('text_input')
          expect(data!.questions[0].options).toBeUndefined()
          expect(data!.questions[1].options).toHaveLength(2)
        } else {
          data!.questions.forEach(q => {
            if (q.options) {
              expect(q.options).toHaveLength(expectedOptionsPerQuestion)
            }
          })
        }
      }
    )
  })

  describe('Edge Cases', () => {
    it('should return null for content without clarification header', () => {
      const result = parseMarkdownClarification('Just some regular markdown content')
      expect(result).toBeNull()
    })

    it('should return null for empty content', () => {
      const result = parseMarkdownClarification('')
      expect(result).toBeNull()
    })

    it('should handle content with prefix and suffix text', () => {
      const content = `Here is some analysis of your requirements.

## Clarification Questions

Q1: Select framework
Type: single_choice
- [✓] \`react\` - React (recommended)
- [ ] \`vue\` - Vue

Please answer the above questions.`

      const result = parseMarkdownClarification(content)

      expect(result).not.toBeNull()
      expect(result!.prefixText).toContain('Here is some analysis')
      expect(result!.suffixText).toContain('Please answer')
      expect(result!.data.questions).toHaveLength(1)
    })

    it('should handle code block wrapped clarification', () => {
      const content = `Some prefix text

\`\`\`markdown
## 🤔 Clarification Questions

### Q1: What framework?
**Type**: single_choice
**Options**:
- [✓] \`react\` - React (recommended)
- [ ] \`vue\` - Vue
\`\`\`

Some suffix text`

      const result = parseMarkdownClarification(content)

      expect(result).not.toBeNull()
      expect(result!.data.questions).toHaveLength(1)
      expect(result!.data.questions[0].options).toHaveLength(2)
    })

    it('should parse last question options correctly when followed by non-empty content (BUG CASE)', () => {
      const content = `## 🤔 Clarification Questions

### Q5: Should there be a separate package for version info and build metadata?
**Type**: single_choice
**Options**:
- [✓] \`yes\` - Yes, create a version package (recommended)
- [ ] \`no\` - No, keep it simple without version package

Please provide your answers in the following format:

\`\`\`markdown
## 📝 My Answers

### Q5: Should there be a separate package for version info and build metadata?
**Answer**: \`yes\` - Yes, create a version package
\`\`\``

      const result = parseMarkdownClarification(content)

      expect(result).not.toBeNull()
      expect(result!.data.questions).toHaveLength(1)

      const options = result!.data.questions[0].options!

      // BUG: The 'no' option should be parsed, not treated as suffix text
      expect(options).toHaveLength(2)
      expect(options[0].value).toBe('yes')
      expect(options[0].label).toBe('Yes, create a version package')
      expect(options[0].recommended).toBe(true)
      expect(options[1].value).toBe('no')
      expect(options[1].label).toBe('No, keep it simple without version package')
      expect(options[1].recommended).toBe(false)
    })

    it('should parse last question options correctly when followed by additional text with empty lines (BUG CASE)', () => {
      const content = `## 🤔 Clarification Questions

### Q5: Should there be a separate package for version info and build metadata?
**Type**: single_choice
**Options**:
- [✓] \`yes\` - Yes, create a version package (recommended)
- [ ] \`no\` - No, keep it simple without version package

Please provide your answers in the following format:

\`\`\`markdown
## 📝 My Answers

### Q5: Should there be a separate package for version info and build metadata?
**Answer**: \`yes\` - Yes, create a version package
\`\`\``

      const result = parseMarkdownClarification(content)

      expect(result).not.toBeNull()
      expect(result!.data.questions).toHaveLength(1)

      const options = result!.data.questions[0].options!

      expect(options).toHaveLength(2)
      expect(options[0].value).toBe('yes')
      expect(options[0].label).toBe('Yes, create a version package')
      expect(options[0].recommended).toBe(true)
      expect(options[1].value).toBe('no')
      expect(options[1].label).toBe('No, keep it simple without version package')
      expect(options[1].recommended).toBe(false)
    })
  })
})
