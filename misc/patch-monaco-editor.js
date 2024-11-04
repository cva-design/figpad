import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

process.chdir(join(__dirname, ".."))

const excludeLibPattern = /dom/
const tsdir = "node_modules/typescript"
const monacoEditorDir = "src/monaco/monaco-editor"


function stripNoDefaultLib(s) {
  // <reference no-default-lib="true"/>
  return s.replace(/\/{3}\s*<reference\s+no-default-lib="true"\s*\/>\r?\n/, "")
}


function stripBlockComments(s) {
  return s.replace(/\/\*\!((?!(\*\/)).)+\*\/\n/gsm, "")
}


function stripLineComments(s) {
  return s.replace(/^\/\/(?:[^\!][^\r\n]*|)\r?\n/gm, "")
}


function visit(file, depth) {
  let s = readFileSync(file, "utf8")

  s = stripBlockComments(s)

  // ^((?!(abc|def)).)*$

  // Copyright

  if (depth < 20) {
    if (depth > 0) {
      // <reference no-default-lib="true"/>
      s = stripNoDefaultLib(s)
    }
    // <reference lib="esnext" />
    s = s.replace(/\/{3}\s*<reference\s+lib="([^"]+)"\s*\/>\r?\n?/g, (substr, path) => {
      const file2path = path.endsWith(".d.ts") ? path : `lib.${path}.d.ts`
      if (excludeLibPattern.test(path)) {
        console.log(`  - ${file2path}`)
        return ""
      }
      console.log(`  + ${file2path}`)
      const file2 = resolve(dirname(file), file2path)
      return `//! ${file2path}\n${visit(file2, depth + 1)}`
    })
  }

  s = stripLineComments(s)

  // console.log(s)
  return s
}

// source all libs
const libEntryFile = `${tsdir}/lib/lib.esnext.full.d.ts`
console.log(`read ${libEntryFile}`)
let str = visit(libEntryFile, 0)

// collapse empty lines
str = str.replace(/^[\r\n]+/gm, "")

// prepend no-default-lib directive
str = `/// <reference no-default-lib="true"/>\n${str}`

// // append DOM, namespaced as WebDOM
// let dom_dts = readFileSync(tsdir + "/lib/lib.dom.d.ts", "utf8")
// dom_dts += "\n" + readFileSync(tsdir + "/lib/lib.dom.iterable.d.ts", "utf8")
// dom_dts = stripBlockComments(dom_dts)
// dom_dts = stripNoDefaultLib(dom_dts)
// dom_dts = stripLineComments(dom_dts)
// str += "\nnamespace WebDOM {\n" + dom_dts + "\n} // namespace WebDOM\n"

// finally, append stuff declared in lib.dom.d.ts which are actually available in
// Figma plugins, like Console.
str += `\n${readFileSync(`${__dirname}/figma-extras.d.ts`, "utf8")}`

// // write build/lib.scripter.d.ts
// writeFileSync("build/lib.scripter.d.ts", str, "utf8")

const js = `export const lib_dts = ${JSON.stringify(str)};`
const scripterLibJsFile = `${monacoEditorDir}/esm/vs/language/typescript/scripter.js`
console.log(`write ${scripterLibJsFile}`)
writeFileSync(scripterLibJsFile, js, "utf8")

function ensurePatch(file, content, pattern, replace) {
  if (content.match(pattern) === null) {
    throw new Error(`Could not match pattern ${String(pattern)} in file ${file}`)
  }

  return content.replace(pattern, replace)
}

const tsWorkerFile = "esm/vs/language/typescript/ts.worker.js";

patch(tsWorkerFile, js => {
  // ...
  // - var libFileMap = {};
  // + import { lib_dts } from './scripter.js';
  // + var libFileMap = {};
  // ...
  js = ensurePatch(tsWorkerFile, js,
    /var libFileMap = {};/m,
    "import { lib_dts } from './scripter.js';\nvar libFileMap = {};"
  )

  // ...
  // - libFileMap["lib.d.ts"] = '..
  // + libFileMap["lib.d.ts"] = lib_dts;
  // ...
  js = ensurePatch(tsWorkerFile, js,
    /libFileMap\["lib.d.ts"\] = '[^\r\n]+/m,
    'libFileMap["lib.d.ts"] = lib_dts;'
  )

  // ...
  // - libFileMap["lib.es6.d.ts"] = '..
  // + libFileMap["lib.es6.d.ts"] = lib_dts;
  // ...
  js = ensurePatch(tsWorkerFile, js,
    /libFileMap\["lib.es6.d.ts"\] = '[^\r\n]+/m,
    'libFileMap["lib.es6.d.ts"] = lib_dts;'
  )

  // ...
  // - text = model.getValue();
  // + text = model.getValue() + "\nexport {};\n";
  // ...
  // This makes all files modules
  js = ensurePatch(tsWorkerFile, js,
    /text\s*=\s*model\.getValue\(\)\s*;/,
    "text = model.getValue() + '\\nexport {};\\n';"
  )
  return js
})

patch("esm/vs/base/common/labels.js", (js, p) => {
  return p.addImport(js, "import * as scripter from '../../editor/scripter.js'")
    .replace(
      /(function\s+getBaseLabel\([^\)]*\)\s+\{)/,
      "$1\n    let s = scripter.getBaseLabel(resource); if (s) { return s }"
    );
})

patch("esm/vs/base/common/resources.js", (js, p) => {
  return p.addImport(js, "import * as scripter from '../../editor/scripter.js'")
    .replace(
      /(function\s+basenameOrAuthority\([^\)]*\)\s+\{)/,
      "$1\n    let s = scripter.basenameOrAuthority(resource);if (s) { return s }"
    );
})


// copy monaco.d.ts and modularize
//
// declare namespace editor {...} => ""
const monacoDtsFile = "src/monaco/monaco.d.ts"
let monacoDts = readFileSync(monacoDtsFile, "utf8")
// declare namespace monaco {
monacoDts = monacoDts.replace(/declare\s+namespace\s+monaco\s*\{\n/gm, "")
//
// remove terminating "}"
const i = monacoDts.lastIndexOf("}", monacoDts.indexOf("declare namespace"))
monacoDts = monacoDts.substring(0, i) + monacoDts.substring(i + 1)
//
// declare namespace monaco.editor {...} => declare namespace editor {...}
// declare namespace monaco.languages.html {
monacoDts = monacoDts.replace(
  /declare\s+namespace\s+monaco\.([^\s]+)\s*\{\n/gm,
  "declare namespace $1 {")
console.log(`write ${monacoDtsFile}`)
writeFileSync(monacoDtsFile, monacoDts, "utf8")



function patch(filename, f) {
  const filePath = resolve(monacoEditorDir, filename)
  let js = readFileSync(filePath, "utf8")
  const p = {
    addImport(js, jsImport) {
      let i = js.lastIndexOf("\nimport")
      i = i === -1 ? 0 : Math.max(js.indexOf("\n", i + 6), i + 7)
      return `${js.substr(0, i)}\n${jsImport}${js.substr(i)}`
    },
  }
  js = f(js, p)
  console.log(`patch ${filePath}`)
  writeFileSync(filePath, js, "utf8")
}
