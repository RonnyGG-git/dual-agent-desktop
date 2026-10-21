/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        coal: { 950: '#101113', 900: '#16171a', 850: '#1b1c20', 800: '#202227', 700: '#2a2d33', 600: '#383b43', 500: '#4b4f59' },
        ink: { 100: '#eceef2', 300: '#b4b8c2', 400: '#8b909c', 500: '#6b707c' },
        claude: '#d97757',
        opencode: '#5aa9e6',
      },
      fontFamily: {
        sans: ['"Segoe UI Variable Text"', '"Segoe UI Variable"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"Cascadia Mono"', '"Cascadia Code"', 'Consolas', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
