/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Neutral slate scale drives the shell; status colors live in StatusPill.
        ink: '#0f172a',
      },
    },
  },
  plugins: [],
};
