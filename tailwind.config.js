// Semantic colours resolve through CSS variables (defined in src/input.css)
// so a single `.dark` class on <html> re-themes the whole app. Values are
// space-separated RGB triples; `<alpha-value>` keeps `/opacity` modifiers working.
const v = (name) => `rgb(var(${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./public/**/*.html', './public/js/**/*.js'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          primary: v('--c-brand-primary'),
          accent: v('--c-brand-accent'),
          50: v('--c-brand-50'),
          100: v('--c-brand-100'),
          600: v('--c-brand-600'),
          700: v('--c-brand-700')
        },
        like: '#21D07A',
        nope: '#FE3C72',
        superlike: '#21A2FF',
        boost: '#9B5CFF',
        rewind: '#FFB800',
        ink: {
          DEFAULT: v('--c-ink'),
          soft: v('--c-ink-soft'),
          faint: v('--c-ink-faint')
        },
        surface: {
          DEFAULT: v('--c-surface'),
          grey: v('--c-surface-grey'),
          cool: v('--c-surface-cool'),
          bubble: v('--c-surface-bubble')
        },
        // Hairlines: replace hard-coded black/5 + black/10 borders, which are
        // invisible against a dark background.
        // Always-dark surfaces (video call stage, toasts, connection banner).
        // Fixed, because white text sits on them in both themes.
        stage: '#111418',
        hairline: v('--c-hairline'),
        line: v('--c-line'),
        track: v('--c-track')
      },
      fontFamily: {
        sans: ['Inter', 'Poppins', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif']
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(90deg, #7B35A8 0%, #B03A93 100%)',
        'brand-gradient-br': 'linear-gradient(135deg, #7B35A8 0%, #B03A93 100%)',
        'card-scrim': 'linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.35) 30%, rgba(0,0,0,0) 60%)'
      },
      boxShadow: {
        card: '0 10px 30px var(--shadow-card)',
        'card-lg': '0 18px 50px var(--shadow-card-lg)',
        action: '0 4px 14px var(--shadow-action)',
        bubble: '0 1px 2px var(--shadow-bubble)',
        lift: '0 14px 38px var(--shadow-lift)'
      },
      borderRadius: {
        '4xl': '2rem',
        '5xl': '2.5rem'
      },
      spacing: {
        'safe-b': 'env(safe-area-inset-bottom)',
        'safe-t': 'env(safe-area-inset-top)'
      },
      keyframes: {
        'swipe-out-right': {
          '0%': { transform: 'translate3d(0,0,0) rotate(0)', opacity: '1' },
          '100%': { transform: 'translate3d(150%,-40px,0) rotate(22deg)', opacity: '0' }
        },
        'swipe-out-left': {
          '0%': { transform: 'translate3d(0,0,0) rotate(0)', opacity: '1' },
          '100%': { transform: 'translate3d(-150%,-40px,0) rotate(-22deg)', opacity: '0' }
        },
        'swipe-out-up': {
          '0%': { transform: 'translate3d(0,0,0) scale(1)', opacity: '1' },
          '100%': { transform: 'translate3d(0,-140%,0) scale(0.9)', opacity: '0' }
        },
        'pop-in': {
          '0%': { transform: 'scale(0.85)', opacity: '0' },
          '60%': { transform: 'scale(1.03)', opacity: '1' },
          '100%': { transform: 'scale(1)', opacity: '1' }
        },
        'fade-up': {
          '0%': { transform: 'translateY(8px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' }
        },
        'fade-out-down': {
          '0%': { transform: 'translateY(0) scale(1)', opacity: '1' },
          '100%': { transform: 'translateY(6px) scale(0.96)', opacity: '0' }
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.9)', opacity: '0.7' },
          '70%': { transform: 'scale(1.35)', opacity: '0' },
          '100%': { transform: 'scale(1.35)', opacity: '0' }
        },
        'heart-float': {
          '0%': { transform: 'translateY(0) scale(0.6)', opacity: '0' },
          '15%': { opacity: '1' },
          '100%': { transform: 'translateY(-120vh) scale(1.2)', opacity: '0' }
        },
        'dot-bounce': {
          '0%, 80%, 100%': { transform: 'translateY(0)', opacity: '0.5' },
          '40%': { transform: 'translateY(-5px)', opacity: '1' }
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' }
        },
        'slide-in-right': {
          '0%': { transform: 'translateX(110%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' }
        }
      },
      animation: {
        'swipe-out-right': 'swipe-out-right 0.42s cubic-bezier(0.22,1,0.36,1) forwards',
        'swipe-out-left': 'swipe-out-left 0.42s cubic-bezier(0.22,1,0.36,1) forwards',
        'swipe-out-up': 'swipe-out-up 0.42s cubic-bezier(0.22,1,0.36,1) forwards',
        'pop-in': 'pop-in 0.32s cubic-bezier(0.22,1,0.36,1) both',
        'fade-up': 'fade-up 0.24s ease-out both',
        'fade-out-down': 'fade-out-down 0.35s ease-in forwards',
        'pulse-ring': 'pulse-ring 1.8s cubic-bezier(0.24,0,0.38,1) infinite',
        'heart-float': 'heart-float 4s linear forwards',
        'dot-bounce': 'dot-bounce 1.2s infinite ease-in-out',
        shimmer: 'shimmer 1.6s infinite',
        'slide-in-right': 'slide-in-right 0.25s cubic-bezier(0.22,1,0.36,1) both'
      }
    }
  },
  plugins: []
};
