import { fileURLToPath } from 'node:url'
import { normalize, join } from 'node:path'
import { defineConfig } from 'vite'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const monacoDir = fileURLToPath(new URL('.', import.meta.url))

// Helper to get Monaco version
const getMonacoVersion = async () => {
  const pkg = await import('./monaco-editor/package.json', { assert: { type: 'json' }})
  return pkg.default.version
}


export default defineConfig(async ({ mode }) => {
  const monacoVersion = await getMonacoVersion()
  const buildDir = join(__dirname, "..", "app", "generated")

  const outDirName = `monaco-${monacoVersion}`
  const isDevMode = mode === 'development'
  
  console.log(`vite building monaco at ${process.cwd()} -> ${outDirName}`)

  return {
    build: {
      outDir: buildDir,
      emptyOutDir: false,
      sourcemap: false,
      rollupOptions: {
        input: join(monacoDir, './monaco.ts'),
        output: {
          entryFileNames: `${outDirName}/[name].js`,
          chunkFileNames: `${outDirName}/[name].js`,
          assetFileNames: `${outDirName}/[name].[ext]`
        }
      },
      minify: isDevMode ? false : 'terser',
      terserOptions: {
        // parallel: true

      }
    },
    plugins: [
      // Monaco Editor Web Workers
      {
        name: 'monaco-workers',
        enforce: 'pre',
        transform(code, id) {
          if (id.includes('monaco-editor/esm/vs/editor/editor.worker')) {
            return {
              code: code.replace(
                'self.MonacoEnvironment',
                'globalThis.MonacoEnvironment'
              ),
              map: null
            }
          }
          return null
        }
      }
    ],
    // resolve: {
    //   alias: {
    //     './monaco-editor': require.resolve('./monaco-editor')
    //   }
    // },
    // optimizeDeps: {
    //   include: ['monaco-editor']
    // },
    css: {
      postcss: {
        plugins: [
          mode === 'production' && require('cssnano')
        ].filter(Boolean)
      }
    }
  }
}) 