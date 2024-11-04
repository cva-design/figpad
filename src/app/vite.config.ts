import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import autoprefixer from 'autoprefixer'
import postcssImport from 'postcss-import'
import postcssPresetEnv from 'postcss-preset-env'
import cssnano from 'cssnano'
import { viteSingleFile } from 'vite-plugin-singlefile';
import resolveNodeModules from '@rollup/plugin-node-resolve';

// Get directory info
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const buildDir = join(__dirname, "..", "..", "build")
const releaseDir = join(__dirname, "..", "..", "docs")

// Version constants
const BUILD_VERSION = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)

// Get package versions
const monacoVersion = (await import('../monaco/monaco-editor/package.json', { assert: { type: 'json' } })).default.version
const sourceMapVersion = (await import('../../node_modules/source-map/package.json', { assert: { type: 'json' } })).default.version

export default defineConfig(({ mode, isPreview }) => {
  const isDevMode = mode === 'development'
  const outDir = isDevMode ? buildDir : releaseDir

  return {
    input: './code/app.ts',
    preview: {
      outDir: releaseDir,
      port: 3000,
      open: true
    },
    build: {
      outDir,
      emptyOutDir: false,
      sourcemap: true,
      rollupOptions: {
        // input: {
        //   resources: './code/resources.ts',
        //   app: './code/app.ts'
        // },
        output: {
          entryFileNames: isDevMode ? '[name].js' : '[name].[hash].js',
          chunkFileNames: isDevMode ? '[name].js' : '[name].[hash].js',
          assetFileNames: isDevMode ? '[name].[ext]' : '[name].[hash].[ext]'
        },
        external: [
          `./monaco-${monacoVersion}/monaco.js`,
          '../monaco/monaco',
          // './resources'
        ]
      },
      minify: isDevMode ? false : 'terser',
      terserOptions: {
        compress: true,
        mangle: true,
        sourceMap: true
      }
    },

    define: {
      DEBUG: isDevMode,
      BUILD_VERSION: JSON.stringify(BUILD_VERSION),
      SOURCE_MAP_VERSION: JSON.stringify(sourceMapVersion),
      MONACO_VERSION: JSON.stringify(monacoVersion)
    },

    resolve: {
      extensions: ['.tsx', '.ts', '.jsx', '.js']
    },

    css: {
      postcss: {
        plugins: [
          autoprefixer(),
          postcssImport(),
          postcssPresetEnv({
            browsers: 'last 2 versions',
            features: {
              'nesting-rules': true
            }
          }),
          // Only use cssnano in production
          !isDevMode && cssnano()
        ].filter(Boolean)
      },
      modules: {
        // Exclude node_modules from CSS modules
        generateScopedName: (name, filename) => {
          return filename.includes('node_modules') ? name : `[name]_[local]_[hash:base64:5]`
        }
      }
    },

    plugins: [
      resolveNodeModules(),
      {
        name: 'html-transform',
        transformIndexHtml: {
          order: 'pre',
          handler(html) {
            return html
              .replace(/\{\{\s*MONACO_VERSION\s*\}\}/g, monacoVersion)
              .replace(/\{\{\s*BUILD_VERSION\s*\}\}/g, BUILD_VERSION)
              .replace(/\.css"/g, `.css?v=${BUILD_VERSION}"`)
              .replace(/\.png"/g, `.png?v=${BUILD_VERSION}"`)
          }
        }
      },
      {
        name: 'copy-assets',
        async writeBundle() {
          // Copy required files
          const { cp } = await import('node:fs/promises')
          await Promise.all([
            cp('./code/figma.d.ts', join(outDir, 'figma.d.ts')),
            cp(
              '../../node_modules/source-map/lib/mappings.wasm',
              join(outDir, `source-map-${sourceMapVersion}-mappings.wasm`)
            )
          ])
        }
      },
      // viteSingleFile(),
    ]
  }
}) 