import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  // ── Library (src/) — strict, type-aware ────────────────────
  {
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.bench.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
      }],
      'no-throw-literal': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      eqeqeq: ['error', 'always'],
    },
  },

  // ── PWA, native bridges, e2e, and root TypeScript ──────────
  // These files are built by Vite/Capacitor/Playwright rather than the library
  // tsconfig, so keep this syntax-aware instead of pretending they belong to
  // the library's type-aware project.
  {
    files: [
      'app/**/*.ts',
      'native/**/*.ts',
      'e2e/**/*.ts',
      '*.config.ts',
    ],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-throw-literal': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      eqeqeq: ['error', 'always'],
    },
  },

  // ── Node scripts and the hand-rolled service worker ────────
  {
    files: [
      '*.js',
      '*.mjs',
      'server/**/*.mjs',
      'scripts/**/*.mjs',
      'native/**/*.mjs',
      'app/public/**/*.js',
    ],
    extends: [eslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      'no-throw-literal': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      eqeqeq: ['error', 'always'],
    },
  },

  // ── Test files — relaxed ───────────────────────────────────
  {
    files: ['**/*.test.ts', '**/*.bench.ts', '**/*.spec.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // ── Global ignores ─────────────────────────────────────────
  {
    ignores: [
      'coverage/',
      'dist/',
      'dist-app/',
      'docs/',
      'node_modules/',
      'android/',
      'native/android/',
      'native/crypto-tests/.gradle/',
      'native/gps-probe/.gradle/',
      'playwright-report/',
      'test-results/',
      'vendor/',
    ],
  },
)
