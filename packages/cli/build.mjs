import { build } from 'esbuild';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));

// Monorepo root (two levels up from packages/cli/)
const root = resolve(__dirname, '../..');

// Path alias map matching root tsconfig.json paths.
// Keys are bare prefixes; values are directories relative to monorepo root.
const aliasMap = {
  '@dino/engine': 'packages/engine/src',
  '@introspection': 'packages/engine/src/introspection',
  '@orchestration': 'packages/engine/src/orchestration',
  '@reporters': 'packages/engine/src/reporters',
  '@intelligence': 'packages/engine/src/intelligence',
  '@pipeline': 'packages/engine/src/pipeline',
  '@config': 'packages/engine/src/config',
  '@utils': 'packages/engine/src/utils',
  '@shared': 'packages/engine/src/shared',
  '@dino/core': 'packages/core/src',
  '@dino/auth': 'packages/auth/src',
  '@dino/plugins': 'packages/plugins/src',
  '@dino/agents': 'packages/agents/src',
  '@dino/analytics': 'packages/analytics/src',
  // NOTE: @dino/reasoning is intentionally EXCLUDED — it is lazy-loaded via
  // dynamic import() in pipeline/runner.ts so it never gets bundled into the
  // CLI binary. Free tier users don't ship LLM provider code.
};

/**
 * esbuild plugin to resolve tsconfig-style path aliases including subpaths.
 * Handles both bare imports (@intelligence) and subpath imports
 * (@introspection/create-discovery-bridge, @pipeline/runner.types).
 */
const tsconfigPathsPlugin = {
  name: 'tsconfig-paths',
  setup(build) {
    // Sort longest-prefix-first so @dino/core matches before @dino
    const entries = Object.entries(aliasMap).sort((a, b) => b[0].length - a[0].length);

    build.onResolve({ filter: /^@/ }, (args) => {
      for (const [prefix, dir] of entries) {
        if (args.path === prefix || args.path.startsWith(prefix + '/')) {
          const suffix = args.path.slice(prefix.length); // '' or '/subpath'
          let resolved = join(root, dir, suffix === '' ? 'index.ts' : suffix.replace(/^\//, ''));
          // esbuild does not auto-add .ts for plugin-returned paths
          if (!existsSync(resolved) && existsSync(resolved + '.ts')) {
            resolved = resolved + '.ts';
          }
          if (!existsSync(resolved) && existsSync(resolved.replace(/\.ts$/, '.tsx'))) {
            resolved = resolved.replace(/\.ts$/, '.tsx');
          }
          return { path: resolved };
        }
      }
      return undefined; // Let esbuild handle it normally
    });
  },
};

const result = await build({
  entryPoints: [join(__dirname, 'src/bin.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(__dirname, 'dist/bin.js'),
  sourcemap: true,
  minify: false,
  treeShaking: true,
  jsx: 'automatic',
  banner: {
    // ESM bundle: esbuild may emit nested `require()` for CJS shims — expose on globalThis (#1014).
    js: '#!/usr/bin/env node\nimport{createRequire}from"module";const require=createRequire(import.meta.url);globalThis.require=require;',
  },
  define: {
    'process.env.NODE_ENV': '"production"', // production React builds (684KB → 394KB savings)
    'process.env.POSTHOG_API_KEY': JSON.stringify(process.env.POSTHOG_API_KEY ?? ''),
  },
  alias: { 'react-devtools-core': join(__dirname, 'noop-devtools.js') },
  external: [
    ...Object.keys(pkg.peerDependencies ?? {}),
    '@dino/reasoning',
    'typescript',  // dev tool — 9.7MB, must not be bundled
  ],
  plugins: [tsconfigPathsPlugin],
  metafile: true,
});

// B49 (#614): Save metafile for CI bundle tracking
if (result.metafile) {
  const fs = await import('node:fs');
  fs.writeFileSync(
    join(__dirname, 'dist/metafile.json'),
    JSON.stringify(result.metafile, null, 2),
  );
}

console.log('Bundle built: dist/bin.js');
