import type { Config } from 'tailwindcss';

/**
 * Token values mirror docs/DESIGN-SYSTEM.md ("Emerald & Copper"). Keep this
 * file and that document in sync — DESIGN-SYSTEM.md is the source of truth.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        emerald: {
          950: '#04201A',
          900: '#072B22',
          800: '#0B3D30',
          700: '#0F5240',
          600: '#14684F',
        },
        copper: {
          900: '#6E4128',
          700: '#9C6240',
          500: '#C8865A',
          300: '#E2AE86',
          100: '#F1D2B6',
        },
        cream: {
          50: '#FAF7F2',
          100: '#F1EAE0',
        },
        ink: {
          900: '#14201B',
          600: '#3E4A45',
        },
        success: '#5CC48F',
        warning: '#E3B25C',
        danger: '#E06B6B',
      },
      backgroundImage: {
        'emerald-gradient': 'linear-gradient(180deg, #0F5240 0%, #0B3D30 45%, #04201A 100%)',
        'copper-gradient':
          'linear-gradient(135deg, #6E4128 0%, #9C6240 18%, #C8865A 38%, #F1D2B6 50%, #C8865A 62%, #9C6240 82%, #6E4128 100%)',
      },
      borderRadius: {
        card: '22px',
        pill: '999px',
      },
      fontFamily: {
        // System-font stack (no network font fetch at build time). The look
        // comes from weight + wide tracking, per docs/DESIGN-SYSTEM.md §2.
        display: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'sans-serif'],
        body: ['ui-sans-serif', 'system-ui', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
};

export default config;
