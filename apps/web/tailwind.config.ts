import type { Config } from 'tailwindcss';

// Approved ConversaFlow palette. "emerald-strong" is a darker shade of the brand green used for
// white-on-green buttons, because white on #10B981 does not meet WCAG AA contrast (about 2.5:1).
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        teal: { DEFAULT: '#0E7490', soft: '#E0F2F7' },
        emerald: { DEFAULT: '#10B981', strong: '#047857', soft: '#D1FAE5' },
        navy: '#0F172A',
        canvas: '#F8FAFC',
        info: '#3B82F6',
        warn: '#F59E0B',
        danger: '#B91C1C',
        accent: '#8B5CF6',
      },
      fontFamily: {
        latin: ['Inter', '"IBM Plex Sans Arabic"', 'system-ui', 'sans-serif'],
        arabic: ['"IBM Plex Sans Arabic"', 'Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config;
