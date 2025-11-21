# Frontend UI Improvements for Shell and Model Configuration

## Overview

This document outlines the required frontend changes to add template buttons and help icons to Shell and Model configuration interfaces in the Wegent project.

---

## 🎯 Objectives

1. **Model Configuration**: Add preset template buttons and documentation help icon to the Agent Config section in BotEdit.tsx
2. **Shell Configuration**: Add documentation help icon (if Shell configuration UI exists)

---

## 📝 Required Changes

### 1. Model Configuration Enhancement (BotEdit.tsx)

**File**: `frontend/src/features/settings/components/BotEdit.tsx`

**Location**: Lines 458-539 (Agent Config section)

#### A. Add Template Buttons

**Insert Position**: After line 481 (after the Custom Model switch)

**New UI Element**: Quick Configuration Template Buttons

```tsx
{/* Template Buttons - Only show when Custom Model is enabled */}
{isCustomModel && (
  <div className="mb-3 p-3 bg-base-secondary rounded-md">
    <div className="text-sm font-medium text-text-primary mb-2">
      📋 {t('bot.quick_templates')}
    </div>
    <div className="flex gap-2 flex-wrap">
      <Button
        size="sm"
        variant="outline"
        onClick={() => handleApplyClaudeSonnetTemplate()}
        className="text-xs"
      >
        Claude Sonnet 4 {t('bot.template')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => handleApplyOpenAIGPT4Template()}
        className="text-xs"
      >
        OpenAI GPT-4 {t('bot.template')}
      </Button>
    </div>
    <p className="text-xs text-text-muted mt-2">
      ⚠️ {t('bot.template_hint')}
    </p>
  </div>
)}
```

#### B. Add Help Icon

**Insert Position**: Line 461 (next to Agent Config label)

```tsx
<div className="flex items-center">
  <label className="block text-base font-medium text-text-primary">
    {t('bot.agent_config')} <span className="text-red-400">*</span>
  </label>
  {/* Help Icon */}
  <button
    type="button"
    onClick={() => handleOpenModelDocs()}
    className="ml-2 text-text-muted hover:text-primary transition-colors"
    title={t('bot.view_model_config_guide')}
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  </button>
</div>
```

#### C. Add Handler Functions

**Insert Position**: After line 140 (in the BotEdit component)

```tsx
// Template handlers
const handleApplyClaudeSonnetTemplate = useCallback(() => {
  const template = {
    env: {
      ANTHROPIC_MODEL: "anthropic/claude-sonnet-4",
      ANTHROPIC_AUTH_TOKEN: "sk-ant-your-api-key-here",
      ANTHROPIC_API_KEY: "sk-ant-your-api-key-here",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-haiku-4.5"
    }
  };
  setAgentConfig(JSON.stringify(template, null, 2));
  setAgentConfigError(false);
  toast({
    title: t('bot.template_applied'),
    description: t('bot.please_update_api_key'),
  });
}, [toast, t]);

const handleApplyOpenAIGPT4Template = useCallback(() => {
  const template = {
    env: {
      OPENAI_API_KEY: "sk-your-openai-api-key-here",
      OPENAI_MODEL: "gpt-4",
      OPENAI_BASE_URL: "https://api.openai.com/v1"
    }
  };
  setAgentConfig(JSON.stringify(template, null, 2));
  setAgentConfigError(false);
  toast({
    title: t('bot.template_applied'),
    description: t('bot.please_update_api_key'),
  });
}, [toast, t]);

// Documentation handler
const handleOpenModelDocs = useCallback(() => {
  const lang = i18n.language === 'zh' ? 'zh' : 'en';
  const docsUrl = `/docs/${lang}/guides/user/configuring-models.md`;
  window.open(docsUrl, '_blank');
}, [i18n.language]);
```

#### D. Required Imports

**Add to imports section** (around line 23):

```tsx
import { useTranslation } from 'react-i18next';
```

(Already imported, no change needed)

---

### 2. I18n Translations

**Files to Update**:
- `frontend/src/i18n/locales/en.json`
- `frontend/src/i18n/locales/zh.json`

**English translations** (`en.json`):

```json
{
  "bot": {
    "quick_templates": "Use Preset Templates for Quick Configuration",
    "template": "Template",
    "template_hint": "Click template button to autofill configuration, then modify the API Key",
    "template_applied": "Template Applied",
    "please_update_api_key": "Please update the API Key to your actual key",
    "view_model_config_guide": "View Model Configuration Guide"
  }
}
```

**Chinese translations** (`zh.json`):

```json
{
  "bot": {
    "quick_templates": "使用预设模板快速配置",
    "template": "模板",
    "template_hint": "点击模板按钮将自动填充配置,您只需修改 API Key 即可",
    "template_applied": "模板已应用",
    "please_update_api_key": "请将配置中的 API Key 修改为您的实际密钥",
    "view_model_config_guide": "查看模型配置详细指南"
  }
}
```

---

### 3. Shell Configuration Enhancement

**Note**: Based on code review, there doesn't appear to be a separate Shell configuration UI. Shell selection is done via the Agent Name dropdown in BotEdit.tsx.

**Recommendation**: Add a help icon next to the Agent Name/Shell selector.

**Insert Position**: Line 435 (next to Agent label)

```tsx
<div className="flex items-center">
  <label className="block text-base font-medium text-text-primary">
    {t('bot.agent')} <span className="text-red-400">*</span>
  </label>
  {/* Help Icon */}
  <button
    type="button"
    onClick={() => handleOpenShellDocs()}
    className="ml-2 text-text-muted hover:text-primary transition-colors"
    title={t('bot.view_shell_config_guide')}
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-5 w-5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  </button>
</div>
```

**Handler Function**:

```tsx
const handleOpenShellDocs = useCallback(() => {
  const lang = i18n.language === 'zh' ? 'zh' : 'en';
  const docsUrl = `/docs/${lang}/guides/user/configuring-shells.md`;
  window.open(docsUrl, '_blank');
}, [i18n.language]);
```

**Additional translations**:

```json
{
  "bot": {
    "view_shell_config_guide": "View Shell Configuration Guide"
  }
}
```

---

## 🎨 UI/UX Considerations

### Template Button Section Design

1. **Visual Hierarchy**:
   - Background: `bg-base-secondary` for subtle distinction
   - Border: Rounded corners for modern feel
   - Spacing: Adequate padding and margins

2. **Responsive Design**:
   - Buttons use `flex-wrap` to stack on small screens
   - Small button size (`size="sm"`) for compact layout

3. **User Feedback**:
   - Toast notification when template is applied
   - Warning hint about updating API Key
   - Error highlighting persists for JSON validation

### Help Icon Design

1. **Position**: Right next to the label for easy discovery
2. **Visual Feedback**:
   - Hover effect: Color changes to primary color
   - Tooltip on hover showing hint text
3. **Accessibility**:
   - Button type for keyboard navigation
   - Title attribute for screen readers

---

## 🔍 Testing Checklist

### Functional Testing

- [ ] Template buttons appear only when "Custom Model" is enabled
- [ ] Clicking Claude Sonnet 4 template fills correct JSON
- [ ] Clicking OpenAI GPT-4 template fills correct JSON
- [ ] Toast notification appears after applying template
- [ ] Help icon opens documentation in new tab
- [ ] Documentation URL correctly switches based on language (zh/en)
- [ ] Filled template passes JSON validation
- [ ] Error highlighting clears when template is applied

### UI Testing

- [ ] Template section displays correctly on desktop
- [ ] Template buttons wrap correctly on mobile
- [ ] Help icon is visible and properly positioned
- [ ] Hover effects work as expected
- [ ] All translations display correctly in both languages

### Integration Testing

- [ ] Templates work with ClaudeCode agent
- [ ] Templates are compatible with existing validation logic
- [ ] Save functionality works correctly with template-filled config
- [ ] No conflicts with existing agent_config logic

---

## 📦 Implementation Steps

1. **Phase 1: Core Functionality**
   - Add template button handlers
   - Add documentation link handlers
   - Add UI components to BotEdit.tsx

2. **Phase 2: I18n**
   - Add English translations
   - Add Chinese translations
   - Test language switching

3. **Phase 3: Testing**
   - Manual testing of all features
   - Cross-browser testing
   - Mobile responsiveness testing

4. **Phase 4: Documentation**
   - Update component documentation
   - Add usage examples
   - Document new props and handlers

---

## 🚀 Expected Benefits

1. **Improved User Onboarding**:
   - New users can quickly get started with templates
   - Reduces configuration errors
   - Clear guidance via help icons

2. **Better Documentation Access**:
   - One-click access to detailed guides
   - Language-aware documentation links
   - Reduced support requests

3. **Enhanced User Experience**:
   - Visual feedback via toast notifications
   - Clear error messaging
   - Intuitive UI flow

---

## 📝 Notes

1. **Alternative Implementation**: If documentation files are served statically, the docsUrl may need to be adjusted based on deployment configuration.

2. **Future Enhancement**: Consider adding more template options (e.g., Azure OpenAI, Claude Haiku).

3. **Validation**: The existing JSON validation in `prettifyAgentConfig` will automatically validate template-filled configs.

4. **Security**: Template API keys are clearly marked as placeholders to prevent accidental use.

---

## 🔗 Related Files

- `frontend/src/features/settings/components/BotEdit.tsx` - Main file to modify
- `frontend/src/i18n/locales/en.json` - English translations
- `frontend/src/i18n/locales/zh.json` - Chinese translations
- `docs/zh/guides/user/configuring-models.md` - Chinese documentation
- `docs/en/guides/user/configuring-models.md` - English documentation
- `docs/zh/guides/user/configuring-shells.md` - Chinese Shell docs
- `docs/en/guides/user/configuring-shells.md` - English Shell docs

---

<p align="center">This improvement will significantly enhance the user experience for Model and Shell configuration! 🚀</p>
