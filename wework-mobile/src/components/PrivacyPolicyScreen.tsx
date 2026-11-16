import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { Button, Text } from 'react-native-paper'
import policies from '@/content/mobilePrivacyPolicy.json'
import { openPrivacyPolicy } from '@/services/privacyPolicy'
import { SettingsPage } from './SettingsScreen'

export function PrivacyPolicyScreen({ onBack }: { onBack: () => void }) {
  const [language, setLanguage] = useState<'zh' | 'en'>('zh')
  const policy = policies[language]
  return (
    <SettingsPage title={language === 'zh' ? '隐私政策' : 'Privacy Policy'} onBack={onBack}>
      <View style={styles.languages}>
        {(['zh', 'en'] as const).map(value => (
          <Button
            key={value}
            testID={`privacy-language-${value}`}
            accessibilityState={{ selected: language === value }}
            mode={language === value ? 'contained-tonal' : 'text'}
            onPress={() => setLanguage(value)}
            contentStyle={styles.action}
          >
            {value === 'zh' ? '中文' : 'English'}
          </Button>
        ))}
      </View>
      <Text accessibilityRole="header" variant="headlineSmall" selectable>
        {policy.title}
      </Text>
      <Text variant="bodySmall" selectable>
        {policy.updated}
      </Text>
      {policy.introduction.map(paragraph => (
        <Text key={paragraph} variant="bodyLarge" selectable style={styles.paragraph}>
          {paragraph}
        </Text>
      ))}
      {policy.sections.map(section => (
        <View key={section.title} style={styles.section}>
          <Text accessibilityRole="header" variant="titleLarge" selectable>
            {section.title}
          </Text>
          {section.paragraphs.map(paragraph => (
            <Text key={paragraph} variant="bodyLarge" selectable style={styles.paragraph}>
              {paragraph}
            </Text>
          ))}
        </View>
      ))}
      <Button
        testID="privacy-public-version"
        onPress={() => void openPrivacyPolicy(language)}
        contentStyle={styles.action}
      >
        {language === 'zh' ? '查看公开版本' : 'View public version'}
      </Button>
    </SettingsPage>
  )
}

const styles = StyleSheet.create({
  languages: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  action: { minHeight: 48 },
  section: { gap: 12 },
  paragraph: { lineHeight: 26 },
})
