// Obsidian's official plugin guidelines (same rules as the community
// directory's automated review). Run: npm run lint
import { defineConfig } from 'eslint/config'
import obsidianmd from 'eslint-plugin-obsidianmd'

export default defineConfig([
  { ignores: ['node_modules/**', 'main.js', 'tests/**', 'scripts/**', '*.mjs', 'test-vault/**'] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.*'] },
      },
    },
    rules: {
      // "vcoder" is a lowercase product name and "/ide" is a CLI command;
      // the heuristic wants "Vcoder" / "/IDE".
      'obsidianmd/ui/sentence-case': ['warn', { brands: ['vcoder', 'Obsidian'], ignoreWords: ['vcoder'], ignoreRegex: ['/ide'] }],
    },
  },
])
