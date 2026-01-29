/** @type {import('tailwindcss').Config} */
export default {
  content: ['./chrome/**/*.{js,ts,jsx,tsx,html}', './shared/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Wegent Calm UI color system
        primary: {
          DEFAULT: 'rgb(20, 184, 166)', // Teal #14B8A6
          light: 'rgb(45, 212, 191)',
          dark: 'rgb(13, 148, 136)',
        },
        surface: 'rgb(247, 247, 248)',
        base: 'rgb(255, 255, 255)',
        border: 'rgb(224, 224, 224)',
        text: {
          primary: 'rgb(26, 26, 26)',
          secondary: 'rgb(102, 102, 102)',
          muted: 'rgb(153, 153, 153)',
        },
      },
      borderRadius: {
        DEFAULT: '0.5rem',
      },
    },
  },
  plugins: [],
}
