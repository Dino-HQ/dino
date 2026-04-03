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
  '@introspection': 'src/introspection',
  '@orchestration': 'src/orchestration',
  '@reporters': 'src/reporters',
  '@intelligence': 'src/intelligence',
  '@pipeline': 'src/pipeline',
  '@config': 'src/config',
  '@utils': 'src/utils',
  '@shared': 'src/shared',
  '@dino/core': 'packages/core/src',
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
  target: 'node18',
  format: 'cjs',
  outfile: join(__dirname, 'dist/bin.js'),
  sourcemap: true,
  minify: true,
  treeShaking: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  // Prevent `if (require.main === module)` guards from firing inside the bundle.
  // In CJS bundles, `require.main === module` is always true since everything is
  // in one file — this silences self-executing blocks in bundled source files.
  define: { 'require.main': 'undefined' },
  // Mark true externals (things users must install or are Node built-ins).
  // @dino/reasoning is lazy-loaded via dynamic import() — exclude it and its
  // transitive deps (@anthropic-ai/sdk) from the bundle so Free tier ships no LLM code.
  external: [...Object.keys(pkg.peerDependencies ?? {}), '@dino/reasoning'],
  plugins: [tsconfigPathsPlugin],
  metafile: true,
});

// B49 (#614): Save metafile for CI bundle tracking
if (result.metafile) {
  const fs = await import('node:fs');
  fs.writeFileSync('dist/metafile.json', JSON.stringify(result.metafile, null, 2));
}

console.log('Bundle built: dist/bin.js');
