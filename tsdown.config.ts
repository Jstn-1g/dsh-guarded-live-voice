import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'
import { defineConfig, type UserConfig } from 'tsdown'

const ID = 'dsh-live-voice'
const EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])
const CSS_PREFIX = '\0dsh-css:'
const CSS_SUFFIX = '.mjs'
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))
const cssFiles = new Map<string, { readonly file: string; readonly stablePath: string }>()

const purityPlugin = {
  name: 'dsh-client-bundle-purity',
  resolveId(source: string) {
    if (!source.startsWith('@deepseek-ai/') || EXTERNALS.has(source)) return null
    throw new Error(`client bundle purity: unsupported value import ${JSON.stringify(source)}`)
  },
}

const cssModulesPlugin = {
  name: 'dsh-css-modules-inline',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css') || importer === undefined) return null
    const file = resolve(dirname(importer), source)
    const stablePath = relative(PROJECT_ROOT, file).replaceAll('\\', '/')
    if (stablePath === '' || stablePath === '..' || stablePath.startsWith('../')) {
      throw new Error('client CSS must stay inside the package root')
    }
    const id = CSS_PREFIX + stablePath + CSS_SUFFIX
    cssFiles.set(id, { file, stablePath })
    return id
  },
  async load(this: { addWatchFile(id: string): void }, id: string) {
    if (!id.startsWith(CSS_PREFIX)) return null
    const resolved = cssFiles.get(id)
    if (resolved === undefined) throw new Error('client CSS virtual module was not resolved')
    const { file, stablePath } = resolved
    this.addWatchFile(file)
    const result = transform({
      filename: stablePath,
      code: await readFile(file),
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classes: Record<string, string> = {}
    for (const [local, value] of Object.entries(result.exports ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      classes[local] = value.name
    }
    const tagId = `${ID}/${basename(file)}`
    return [
      `const css=${JSON.stringify(result.code.toString())};`,
      `const tagId=${JSON.stringify(tagId)};`,
      'if(typeof document!=="undefined"&&document.querySelector("style[data-plugin-css="+JSON.stringify(tagId)+"]")===null){',
      `const tag=document.createElement("style");tag.dataset.plugin=${JSON.stringify(ID)};tag.dataset.pluginCss=tagId;tag.textContent=css;document.head.appendChild(tag);}`,
      `export default ${JSON.stringify(classes)};`,
    ].join('\n')
  },
}

const host: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  fixedExtension: false,
  dts: true,
  clean: false,
  deps: { neverBundle: [/^@deepseek-ai\//] },
}

const client: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => EXTERNALS.has(specifier),
    alwaysBundle: (specifier: string) => !EXTERNALS.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [purityPlugin, cssModulesPlugin],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([host, client])
