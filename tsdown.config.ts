/**
 * Two build faces in one package:
 * - the node half (lib/index.js), loaded by the Host Loader through the
 *   cordis patch row that names this package;
 * - the browser half (lib/client.js), a CJS closure registered with the
 *   shell's frozen module loader. Shared framework code stays external and
 *   resolves through the injected `require` (the loader module table), so the
 *   external list mirrors deepseek-harness `packages/client/web/src/platform.ts`
 *   plus the documented runtime-client exemption.
 */
import type { UserConfig } from 'tsdown'

const ID = 'dsh-speech-plugin'

/** Externals answered by the shell module table (platform seed entries + the runtime-client exemption). */
const PLATFORM_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Node half: the settings registration. Runtime imports resolve from the composition's node_modules. */
const lib: UserConfig = {
  name: ID,
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  // Keep the ESM artifact at .js: package.json "type": "module" already says
  // so, and the exports map plus the Loader both address lib/index.js.
  fixedExtension: false,
  dts: false,
  clean: false,
}

/** Browser half: the __ModuleLoader__ closure bundle served at /plugins/<id>/client.js. */
const client: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...PLATFORM_EXTERNALS],
  noExternal: id => (PLATFORM_EXTERNALS.includes(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [lib, client]
