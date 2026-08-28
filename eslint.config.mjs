// ESLint flat config for the Bruno Backstage plugins.
//
// This is a faithful port of bruno-api-docs' eslint.config.mjs
// (https://github.com/usebruno/... eslint.config.mjs) with the following
// POC-specific adaptations:
//
//   1. eslint-plugin-diff is OMITTED (plugin + `processor: 'diff/…'`). That
//      plugin lints only changed lines against the git diff — a CI/PR
//      optimization for the published package. Our POC plugin files are
//      untracked, so the diff processor would make lint a no-op. All other
//      rules are kept identical.
//   2. `files` globs are scoped to the code we authored:
//        eslint.config.mjs, plugins/bruno/src, plugins/bruno-backend/src.
//      packages/app and packages/backend are Backstage scaffold and keep
//      their own (backstage-cli) lint.
//   3. `ignores` mirrors upstream plus '**/dist-types/**'.
//   4. `import/no-extraneous-dependencies` packageDir points at the repo root
//      and both plugin package dirs.
//   5. The no-restricted-syntax hex-colour ban is kept, with a scoped override
//      turning it OFF for files that legitimately hold colour tokens
//      (MethodBadge, generateCollectionHtml.ts) — mirroring how upstream
//      exempts its theme/** files.
//   6. Dropped bruno-api-docs-specific rules that do not apply here: the
//      react-hooks e2e override and the '@slices/*' no-restricted-imports rule.

import globals from 'globals';
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';
import importPlugin from 'eslint-plugin-import';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

// Anything that looks like a hex colour literal. Colours belong in the theme
// tokens and reach components as CSS custom properties.
const HEX_COLOUR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-standalone/**',
      '**/dist-server/**',
      '**/dist-types/**',
      '**/playwright-report/**',
      '**/bundled-libraries.iife.js',
      '**/.claude/**'
    ]
  },
  {
    plugins: {
      '@stylistic': stylistic,
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
      'import': importPlugin
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true }
      },
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    files: [
      'eslint.config.mjs',
      'plugins/bruno/src/**/*.{ts,tsx}',
      'plugins/bruno-backend/src/**/*.{ts,tsx}',
      'scripts/**/*.mjs'
    ],
    rules: {
      ...js.configs.recommended.rules,
      ...stylistic.configs.customize({
        indent: 2,
        quotes: 'single',
        semi: true,
        jsx: true
      }).rules,
      '@stylistic/comma-dangle': ['error', 'never'],
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
      '@stylistic/arrow-parens': ['error', 'always'],
      '@stylistic/array-bracket-spacing': ['error', 'never'],
      '@stylistic/arrow-spacing': ['error', { before: true, after: true }],
      '@stylistic/function-call-spacing': ['error', 'never'],
      '@stylistic/semi-style': ['error', 'last'],
      '@stylistic/max-len': ['error', {
        code: 120,
        ignoreUrls: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreRegExpLiterals: true
      }],
      // JSX makes these three noisy without making anything safer.
      '@stylistic/multiline-ternary': ['off'],
      '@stylistic/padding-line-between-statements': ['off'],
      '@stylistic/jsx-one-expression-per-line': ['off'],
      '@stylistic/max-statements-per-line': ['off'],

      // TypeScript already resolves identifiers and reports unused code more
      // accurately than the core rules, which misfire on types and interfaces.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],

      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],

      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-debugger': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // Anything imported by runtime code has to be a real dependency — a
      // devDependency would break consumers the moment a dep stops being bundled.
      'import/no-extraneous-dependencies': ['error', {
        packageDir: ['.', './plugins/bruno', './plugins/bruno-backend'],
        devDependencies: [
          '**/*.{test,spec}.{ts,tsx}',
          '**/e2e/**',
          '**/test-utils/**',
          '**/*.config.{ts,mts,js,mjs,cjs}',
          '**/*.d.ts'
        ]
      }],

      'no-restricted-syntax': ['error',
        {
          selector: `Literal[value=/^${HEX_COLOUR.source}$/]`,
          message: 'Use a theme CSS variable (var(--…)) instead of a hardcoded colour.'
        },
        {
          selector: `TemplateElement[value.raw=/${HEX_COLOUR.source}/]`,
          message: 'Use a theme CSS variable (var(--…)) instead of a hardcoded colour.'
        }
      ],

      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    // These files legitimately hold colour tokens: MethodBadge maps HTTP
    // methods to colours, BrunoLogo carries the brand mark's own fills, and
    // generateCollectionHtml emits a standalone HTML document with inline
    // styling. Mirrors how upstream exempts theme/**.
    files: [
      'plugins/bruno/src/components/MethodBadge/**/*.{ts,tsx}',
      'plugins/bruno/src/components/BrunoLogo/**/*.{ts,tsx}',
      'plugins/bruno-backend/src/service/generateCollectionHtml.ts'
    ],
    rules: {
      'no-restricted-syntax': 'off'
    }
  },
  {
    // Tests and dev scripts legitimately log.
    files: [
      'plugins/**/*.{test,spec}.{ts,tsx}',
      'plugins/**/e2e/**/*.{ts,tsx}'
    ],
    rules: {
      'no-console': 'off'
    }
  },
  {
    // Repo scripts are CLIs run from the root: stdout is their interface, and
    // they import the root workspace's own devDependencies rather than a
    // per-package manifest.
    files: ['scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
      'import/no-extraneous-dependencies': 'off'
    }
  }
];
