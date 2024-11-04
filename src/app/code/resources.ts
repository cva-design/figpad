// NOTE: This file is special. It is built separately, loaded very early and
// linked at runtime via window["__resources"].
// Because of this, only the one default export is valid. Any other export will fail.
import * as tslibs from "../generated/tslibs"

declare const BUILD_VERSION :string

export class Resource {
  readonly name     :string
  readonly filename :string
  readonly version  :string
  readonly body     :Promise<string>

  constructor(name :string, info :{ filename :string, version :string }) {
    this.name = name
    this.filename = info.filename
    this.version = info.version
    this.body = this.loadText(`${this.filename}?v=${info.version}`)
  }

  private loadText(url :string) :Promise<string> {
    return fetch(url).then(r => {
      if (r.status >= 200 && r.status <= 299) {
        return r.text()
      }
      
      throw new Error(`HTTP GET ${url} -> ${r.status} ${r.statusText}`)
    })
  }
}

declare const window: Window & { __resources: Resource[] }

window.__resources = [
  new Resource("Figma API",     tslibs.figma),
  new Resource("Scripter API",  tslibs.scripter),
  new Resource("WebDOM API",    tslibs.dom),
  new Resource("WebWorker API", tslibs.webworker),
]

export default window.__resources;
