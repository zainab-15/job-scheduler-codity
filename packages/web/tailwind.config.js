/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Manrope',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      colors: {
        // Warm near-black used for primary headings / ink.
        ink: '#241F18',

        // --- Warm neutral scale ---
        // Overrides Tailwind's cool `slate-*`. The app already leans on slate for
        // every neutral surface, border, and label, so warming the scale here
        // reskins the whole product to an ivory/sand palette from one place.
        slate: {
          50: '#FBF8F3',
          100: '#F4EFE8',
          200: '#E9E2D7',
          300: '#D8CFC0',
          400: '#B0A593',
          500: '#867C6D',
          600: '#655C4F',
          700: '#4B4438',
          800: '#352F26',
          900: '#241F18',
          950: '#17130E',
        },

        // --- Blush / rose-pink accent ---
        // Overrides `indigo-*`, which the app uses ONLY for interactive/brand
        // accents (primary buttons, active tabs, links, icons, highlights,
        // badges). A fresher, more vibrant rose-pink than the old dusty rose —
        // still soft and elegant, never mauve/burgundy/neon. 600 keeps AA
        // contrast with white for buttons.
        indigo: {
          50: '#FDF2F6',
          100: '#FCE7EE',
          200: '#F9CEDD',
          300: '#F4A8C2',
          400: '#EC7BA0',
          500: '#E15981',
          600: '#C8446C',
          700: '#A93A5A',
          800: '#8C3049',
          900: '#74293D',
          950: '#451523',
        },

        // --- Softened, pastel status greens & reds ---
        // Overrides Tailwind's vivid emerald/red so success & failure read gently
        // within the warm pastel theme (still clearly green = good, red = alert).
        emerald: {
          50: '#EEF6F1',
          100: '#DBEDE3',
          200: '#BEDDCE',
          300: '#97C9B0',
          400: '#66B18F',
          500: '#4EA07E',
          600: '#3E8A6B',
          700: '#35705A',
          800: '#2C5748',
          900: '#26483C',
          950: '#122820',
        },
        red: {
          50: '#FCEFEE',
          100: '#F9E1DF',
          200: '#F3C9C6',
          300: '#E9A7A3',
          400: '#DD827D',
          500: '#D26B66',
          600: '#BD534F',
          700: '#A24340',
          800: '#833835',
          900: '#6E302E',
          950: '#3F1817',
        },

        // Semantic aliases for new markup (same values as above).
        sand: {
          50: '#FBF8F3',
          100: '#F4EFE8',
          200: '#E9E2D7',
          300: '#D8CFC0',
          400: '#B0A593',
          500: '#867C6D',
          600: '#655C4F',
          700: '#4B4438',
          800: '#352F26',
          900: '#241F18',
        },
        rose: {
          50: '#FDF2F6',
          100: '#FCE7EE',
          200: '#F9CEDD',
          300: '#F4A8C2',
          400: '#EC7BA0',
          500: '#E15981',
          600: '#C8446C',
          700: '#A93A5A',
          800: '#8C3049',
          900: '#74293D',
        },
        accent: {
          DEFAULT: '#C8446C',
          fg: '#A93A5A',
          soft: '#FDF2F6',
        },
      },
      boxShadow: {
        // Subtle, warm-tinted shadows — soft, never heavy or glowing. Tuned so
        // white cards read as clearly lifted off the light beige canvas.
        soft: '0 1px 2px 0 rgb(40 31 24 / 0.05), 0 2px 6px -1px rgb(40 31 24 / 0.07)',
        card: '0 1px 2px rgb(40 31 24 / 0.05), 0 8px 24px -8px rgb(40 31 24 / 0.12)',
        // Soft, diffuse elevation for floating preview cards (no border needed).
        'soft-lg': '0 1px 2px rgb(40 31 24 / 0.04), 0 4px 14px -4px rgb(40 31 24 / 0.07), 0 18px 40px -20px rgb(40 31 24 / 0.13)',
        pop: '0 10px 34px -10px rgb(40 31 24 / 0.18)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'toast-in': {
          from: { opacity: '0', transform: 'translateY(8px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.25s ease-out both',
        'toast-in': 'toast-in 0.2s ease-out both',
      },
    },
  },
  plugins: [],
};
