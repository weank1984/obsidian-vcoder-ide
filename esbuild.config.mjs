import { builtinModules } from 'node:module'
import process from 'node:process'
import esbuild from 'esbuild'

const prod = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

const builtins = [...builtinModules, ...builtinModules.map(m => `node:${m}`)]

const ctx = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    // ws optional native accelerators — not bundled, ws falls back to JS.
    'bufferutil',
    'utf-8-validate',
    ...builtins,
  ],
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  minify: prod,
  outfile: 'main.js',
})

if (watch) {
  await ctx.watch()
} else {
  await ctx.rebuild()
  await ctx.dispose()
}
