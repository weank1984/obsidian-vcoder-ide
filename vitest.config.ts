import { defineConfig } from 'vitest/config'

// Tests cover src/core only (no `obsidian` runtime import); the Obsidian
// adapter layer is verified end-to-end in a real vault.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
