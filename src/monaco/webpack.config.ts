import { fileURLToPath } from 'node:url'
import { normalize, join } from 'node:path'
import { resolve as origResolve } from 'node:module'
import webpack from 'webpack'
import MonacoWebpackPlugin from 'monaco-editor-webpack-plugin'
import MiniCssExtractPlugin from 'mini-css-extract-plugin'
import TerserJSPlugin from 'terser-webpack-plugin'
import OptimizeCSSAssetsPlugin from 'optimize-css-assets-webpack-plugin'

const monacoDir = fileURLToPath(new URL('.', import.meta.url))

const resolve = (path, options) => {
  console.log("resolve", path)
  return origResolve(path, options)
}

const getMonacoVersion = async () => {
  const pkg = await import('./monaco-editor/package.json', { assert: { type: 'json' }})
  return pkg.default.version
}

const builddir = normalize(join(monacoDir, "..", "..", "build"))

export default (async () => {
  const monacoVersion = await getMonacoVersion()
  const outdirname = `monaco-${monacoVersion}`

  console.log(`webpack building monaco at ${process.cwd()} -> ${outdirname}`)

  return (env, argv) => {
    const mode = argv.mode === 'production' ? 'production' : 'development'
    const isDevMode = mode === 'development'
    return {
      mode,
      devtool: false,
      entry: { monaco: "./monaco.ts" },
      resolve: { extensions: ['.tsx', '.ts', '.jsx', '.js'] },
      output: {
        filename: `${outdirname}/[name].js`,
        path: join(builddir, isDevMode ? "dev" : "release"),
      },
      module: {
        rules: [
          {
            test: /\.css$/,
            use: [
              { loader: MiniCssExtractPlugin.loader },
              'css-loader',
            ],
          },
          {
            test: /\.(woff(2)?|ttf|eot|svg)$/,
            use: {
              loader: 'url-loader',
            },
          },
        ]
      },

      optimization: isDevMode ? {} : {
        minimizer: [
          new TerserJSPlugin({
            parallel: true,
          }),
          new OptimizeCSSAssetsPlugin({}),
        ],
      },

      plugins: [

        new MiniCssExtractPlugin({
          filename: `${outdirname}/[name].css`,
          chunkFilename: `${outdirname}/[id].css`,
          ignoreOrder: false,
        }),

        new MonacoWebpackPlugin({
          languages: ["typescript"],
          publicPath: "/",
          filename: `${outdirname}/[name].worker.js`,
        }),

        new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
      ],
    }
  }
})()
