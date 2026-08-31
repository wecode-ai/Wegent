import { MD3DarkTheme, MD3LightTheme, type MD3Theme } from 'react-native-paper'

const shared = {
  roundness: 3,
}

export const lightTheme: MD3Theme = {
  ...MD3LightTheme,
  ...shared,
  colors: {
    ...MD3LightTheme.colors,
    primary: '#181818',
    onPrimary: '#ffffff',
    primaryContainer: '#ededed',
    onPrimaryContainer: '#181818',
    secondary: '#414141',
    onSecondary: '#ffffff',
    secondaryContainer: '#ededed',
    onSecondaryContainer: '#181818',
    tertiary: '#5d5d5d',
    tertiaryContainer: '#f3f3f3',
    background: '#ffffff',
    surface: '#ffffff',
    surfaceVariant: '#f3f3f3',
    outline: '#dedede',
    outlineVariant: '#ededed',
    elevation: {
      ...MD3LightTheme.colors.elevation,
      level1: '#f9f9f9',
      level2: '#f3f3f3',
      level3: '#ededed',
      level4: '#ededed',
      level5: '#ededed',
    },
  },
}

export const darkTheme: MD3Theme = {
  ...MD3DarkTheme,
  ...shared,
  colors: {
    ...MD3DarkTheme.colors,
    primary: '#ffffff',
    onPrimary: '#181818',
    primaryContainer: '#303030',
    onPrimaryContainer: '#ffffff',
    background: '#000000',
    onBackground: '#ffffff',
    surface: '#181818',
    onSurface: '#ffffff',
    surfaceVariant: '#303030',
    onSurfaceVariant: '#afafaf',
    outline: '#414141',
    outlineVariant: '#303030',
    elevation: {
      ...MD3DarkTheme.colors.elevation,
      level1: '#181818',
      level2: '#212121',
      level3: '#282828',
      level4: '#282828',
      level5: '#303030',
    },
  },
}
