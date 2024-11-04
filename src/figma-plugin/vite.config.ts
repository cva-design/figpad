import { fileURLToPath } from 'node:url';

import { svelteWarnings } from '@cva.design/figma-sdk/config/svelte-warnings';
import image from '@rollup/plugin-image';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { sveltePreprocess } from 'svelte-preprocess';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

import * as esbuild from 'esbuild';
import tsConfig from './tsconfig.json';

// https://vitejs.dev/config/

/*
 * Example argv when running `vite dev`
 * [
 *   '/Users/svallory/.proto/tools/node/20.11.0/bin/node',
 *   '/work/cva/code/apps/plugin-v1/node_modules/vite/bin/vite.js',
 *   'dev'
 * ]
 */
const viteDevWasDirectlyCalled = () => {
  return (
    process.argv[0].endsWith('node') &&
    // $1 contains bin/vite
    process.argv[1].match(/vite\/bin\/vite/) &&
    // $2 === 'dev'
    process.argv[2] === 'dev'
  );
};

export default defineConfig(({ command, mode }) => {
  if (viteDevWasDirectlyCalled()) {
    console.log(
      `
  *********************************************************
  *    You cannot develop Figma plugins using vite dev    *
  *                                                       *
  *    Vite dev serves the app from memory but Figma      *
  *    loads the plugin code from the dist folder.        *
  *                                                       *
  *    If you want to develop the plugin, please use      *
  *    one of the provided 'dev:' scripts.                *
  *                                                       *
  *    $ nr dev                                           *
  *********************************************************
      `,
    );
    throw new Error('vite dev is not supported for developing Figma plugins');
  }

  const baseUrl = fileURLToPath(new URL('./src', import.meta.url));
  const sdkPath = fileURLToPath(
    new URL('../../packages/figma-sdk/src/lib', import.meta.url),
  );

  const BUILD_OPTIONS: {
    minify: boolean;
    /**
     * This varies between Vite to esbuild.
     *
     * | esbuild      | vite     |
     * | ------------ | -------- |
     * | true, linked | true     |
     * | both         | x        |
     * | external     | hidden   |
     * | inline       | inline   |
     *
     * @see {@link https://esbuild.github.io/api/#sourcemap|esbuild supported values}
     * @see {@link https://vite.dev/config/build-options.html#build-sourcemap|vite supported values}
     */
    sourcemap: false | 'inline';
    platform: 'browser' | 'node';
    target: string[];
  } = {
    minify: mode === 'production',
    sourcemap: mode === 'production' ? false : 'inline',
    platform: 'browser',
    target: ['es6'],
  };

  console.log({
    command,
    mode,
    BUILD_OPTIONS,
  });
  return {
    root: './src',
    build: {
      outDir: '../dist',
      assetsInlineLimit: 100000000,
      chunkSizeWarningLimit: 100000000,
      cssCodeSplit: false,
      rollupOptions: {
        input: './src/ui/index.html',
        output: {
          // manualChunks: {
          //   tslib: ["tslib"]
          // },
          inlineDynamicImports: true,
        },
        external: [], // Ensure tslib is not listed here
      },
      terserOptions: {
        compress: {
          drop_console: mode === 'production',
        },
      },
      emptyOutDir: false,
      watch:
        mode === 'development'
          ? {
              include: ['src/**/*', 'ui/**/*'],
            }
          : null,
      ...BUILD_OPTIONS,
    },
    optimizeDeps: {
      include: ['tslib'],
    },
    resolve: {
      conditions: ['cva-dev'],
      alias: [
        {
          find: /@(ui|shared|code)(.*)?/,
          replacement: `${baseUrl}/$1$2`,
        },
        {
          find: /\$figma-sdk(.*)?/,
          replacement: `${sdkPath}$1`,
        },
        {
          find: /\$(ui|icons)(.*)?/,
          replacement: `${sdkPath}/$1$2`,
        },
      ],
    },

    plugins: [
      vitePreprocess({
        script: true,
        style: true,
      }),
      svelte({
        compilerOptions: {
          customElement: true,
        },

        preprocess: sveltePreprocess({
          aliases: Object.entries((tsConfig.compilerOptions.paths || {}) as Record<string, string[]>).map(
            ([key, value]: [string, string[]]) => [key, value[0]],
          ),
          typescript: {
            tsconfigFile: 'tsconfig.json',
          },
        }),
      }),
      svelteWarnings({
        disable: ['css-unused-selector', /a11y*/],
        summary: 'all',
        listAllCodes: true,
      }),
      image() as any,
      viteSingleFile(),
      {
        name: 'post-build',
        async closeBundle() {
          await esbuild.build({
            entryPoints: ['src/code/init.ts'],
            outfile: 'dist/code/index.js',
            bundle: true,
            ...BUILD_OPTIONS,
          });
        },
      },
      {
        name: 'verbose-hmr',
        handleHotUpdate({ file, modules, read }) {
          console.log('File changed:', file);
          console.log(
            'Affected modules:',
            modules.map((m) => m.id),
          );
          console.log('Module update prevented:', modules.length === 0);
          return modules;
        },
      },
    ],
  };
});
