import js from '@eslint/js';
import globals from 'globals';

/**
 * Flat config (ESLint 9). Two environments in one repo:
 *   - server/**, db/**, scripts/**  -> Node ESM
 *   - public/js/**                  -> browser ESM
 */
export default [
  {
    ignores: [
      'node_modules/**',
      'public/css/**',
      'uploads/**',
      'tmp/**',
      'coverage/**'
    ]
  },

  js.configs.recommended,

  // ---------------------------------------------------------------- server
  {
    files: ['server/**/*.js', 'db/**/*.js', 'scripts/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      eqeqeq: ['warn', 'smart'],
      'prefer-const': 'warn',
      'no-var': 'error',
      'object-shorthand': 'warn',
      'no-return-await': 'warn',
      'require-await': 'off'
    }
  },

  // --------------------------------------------------------------- browser
  {
    files: ['public/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        RTCPeerConnection: 'readonly',
        RTCSessionDescription: 'readonly',
        RTCIceCandidate: 'readonly',
        MediaStream: 'readonly',
        webkitAudioContext: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['warn', 'smart'],
      'prefer-const': 'warn',
      'no-var': 'error',
      'object-shorthand': 'warn',
      // The app must never persist tokens in web storage.
      'no-restricted-globals': [
        'error',
        { name: 'localStorage', message: 'Auth state lives in httpOnly cookies - do not use localStorage.' },
        { name: 'sessionStorage', message: 'Auth state lives in httpOnly cookies - do not use sessionStorage.' }
      ]
    }
  }
];
