// This library exports a single function:
//    function evalScript(reqId :string, js :string) :Promise<any>
//
// evalScript executes a script in the scripter environment.
//
// Note: scripter-env.d.ts is not the definition file for the API of this library,
// but the definitions of the environment of a script.
//

// scriptLib is defined in script-lib.ts
var scriptLib = {};
const evalScript = (function(){

function _assertFailure(args) {
  let e = new Error(args.length > 0 ? args.join(", ") : "assertion failed")
  e.name = "AssertionError"
  throw e
}

function assert(condition) {
  if (!condition) {
    // separating the handler from the test may allow a JS compiler to inline the test
    _assertFailure([].slice.call(arguments, 1))
  }
}

function isTypedArray(v) {
  return v.buffer instanceof ArrayBuffer && v.BYTES_PER_ELEMENT !== undefined
}


function preClone(v, seen) {
  if (!v) {
    return v
  }

  let v2 = seen.get(v)
  if (v2 !== undefined) {
    return v2
  }
  seen.set(v, v)

  if (typeof v == "object") {
    if (v instanceof Array) {
      return v.map(v => preClone(v, seen))
    }

    if (v instanceof Date) {
      return String(v)
    }

    if (v instanceof Error) {
      let stackFrames = scriptLib.getUserStackFrames(v.stack)
      return { __scripter_error__: {
        str: String(v),
        stack: stackFrames.slice(0, stackFrames.length-1), // drop main
        srcpos: scriptLib.getFirstSourcePosInStackFrames(stackFrames, /* stackOffset */1),
      } }
    }

    // make sure we don't send huge chunks of data over ipc.
    // This number should be slightly larger than the length cap constant in fmtval.ts
    if (v instanceof ArrayBuffer) {
      return v.slice(0, 50)
    }
    if (isTypedArray(v)) {
      return v.subarray(0, 50)
    }

    // pass through special objects like Img and LazySeq verbatim
    for (let k in scriptLib.markerProps) {
      if (k in v) {
        return v
      }
    }

    let v2 = {}
    for (let k in v) {
      v2[k] = preClone(v[k], seen)
    }
    seen.set(v, v2)
    return v2
  }

  return v
}


function _print(env, reqId, args) {
  console.log.apply(console, args)
  if (!env.scripter.visualizePrint || env.canceled) {
    return
  }

  let seen = new Map()
  args = args.map(arg => preClone(arg, seen))

  // [fig-js limitation] calls in lambda-style functions have no source location
  // in stack frame. In this case, we pick the first frame that has source location.
  //
  // Note: stackOffset is 2 here to exclude both the call frame for
  // - this function (_print)
  // - its parent function (print)
  let srcPos = scriptLib.getFirstSourcePos(/* stackOffset */2)
  if (srcPos.line == 0) {
    // unable to find source location :-(
    return
  }

  let msg = { // PrintMsg
    type: "print",
    message: "",
    args: args,
    reqId: reqId,
    srcPos: srcPos,
    srcLineOffset: _evalScript.lineOffset,
  }

  // send to ui
  try {
    figma.ui.postMessage(msg)
  } catch (_) {
    // something that can't be cloned
    delete msg.args
    msg.message = scriptLib.fmtPrintArgs(args)
    figma.ui.postMessage(msg)
    // run through json as fallback
    // try {
    //   for (let i = 0; i < msg.args.length; i++) {
    //     if (typeof msg.args[i] == "function") {
    //       msg.args[i] = "[Function]"
    //     }
    //   }
    //   msg.args = JSON.parse(JSON.stringify(msg.args))
    //   figma.ui.postMessage(msg)
    // } catch (_) {}
  }
}

// ------------------------------------------------------------------------------------------

const _unavail = (name, msg) => () => {
  let e = new Error(name + " is unavailable in Scripter" + (msg ? ". " + msg : ""))
  e.name = "ScripterError"
  throw e
}

const ui = {
  show:   _unavail("ui.show"),
  hide:   _unavail("ui.hide"),
  resize: _unavail("ui.resize"),
  close:  _unavail("ui.close"),
  postMessage: _unavail("postMessage"),
  get onmessage() { return undefined },
  set onmessage(_) { _unavail("ui.onmessage") },
}

// "figma" object with some features disabled or shimmed.
// This is the object that's exposed as "figma" in a script.
const figmaObject = Object.create(figma, {
  // UI manipulation is disabled
  ui: { value: ui, enumerable: true },
  showUI: { value: _unavail("showUI") },

  // closePlugin is fine, but closeScripter is portable -- show a warning.
  closePlugin: {
    value: function closePlugin(message) {
      console.warn("Consider using scripter.close(message?:string) instead of figma.closePlugin")
      return figma.closePlugin(message)
    },
    enumerable: true
  },
})


// ------------------------------------------------------------------------------------------
// Timers

// _timerDebug(id :number, ...args :any[])
// _timerDebug(id :null, ...args :any[])
let _timerDebug = DEBUG ? function(id /* ...args */) {
  console.log.apply(console, [
    typeof id == "number" ? `[timer #${id}]` : "[timer]"
  ].concat([].slice.call(arguments, 1)))
} : function(){}
let _timers = {}
let _timerWaitPromise = null

const TIMER_KIND_TIMEOUT = 1
const TIMER_KIND_INTERVAL = 2
const TIMER_KIND_ANIMATE = 3

class TimerCancellation extends Error {
  constructor() {
    super("Timer canceled")
    this.name = "TimerCancellation"
  }
}

// wrappers to work around bug in fig-js where
// calling clearTimeout with an invalid timer causes a crash.
function __clearTimeout(id) {
  try { clearTimeout(id) } catch(_) {}
}
function __clearInterval(id) {
  try { clearInterval(id) } catch(_) {}
}

function _awaitAsync() {
  _timerDebug(null, "_awaitAsync")
  for (let _ in _timers) {
    return new Promise((resolve, reject) => {
      _timerDebug(null, "_awaitAsync setting _timerWaitPromise with _timers=", _timers)
      _timerWaitPromise = { resolve, reject }
    })
  }
  // no timers
  _timerDebug(null, "_awaitAsync resolving immediately")
  return Promise.resolve()
}

function _cancelAllTimers(error) {
  _timerDebug(null, `_cancelAllTimers`)
  let timers = _timers
  _timers = {}
  for (let id in timers) {
    let t = timers[id]
    if (t === undefined) {
      continue
    } else if (t === TIMER_KIND_TIMEOUT) {
      _timerDebug(id, `_cancelAllTimers clearTimeout`)
      __clearTimeout(id)
    } else if (t === TIMER_KIND_INTERVAL) {
      _timerDebug(id, `_cancelAllTimers clearInterval`)
      __clearInterval(id)
    } else {
      // Promise rejection function
      _timerDebug(id, `_cancelAllTimers reject`)
      __clearTimeout(id)
      __clearInterval(id)
      try { t(new TimerCancellation()) } catch(_) {}
    }
  }
  if (_timerWaitPromise) {
    try { _timerWaitPromise.reject(error) } catch(_) {}
    _timerWaitPromise = null
  }
}


// interface Timer extends Promise<void> { cancel():void }
// timer(duration :number, handler :(canceled?:boolean)=>any) :Timer
function Timer(duration, f) {
  if (this.canceled) { throw new Error("script canceled") }
  var id, rejectfun, resolvefun

  let p = new Promise((resolve, reject) => {
    id = setTimeout(
      f ? () => {
        _clearTimer(id)
        try {
          f(/* canceled */false)
          resolve()
        } catch (e) {
          _timerDebug(id, `exception in handler ${e}`)
          reject(e)
        }
      } : () => {
        _clearTimer(id)
        resolve()
      },
      duration
    )
    resolvefun = resolve
    _timerDebug(id, `Timer() start`)
    _timers[id] = rejectfun = reject
    return id
  })

  p.cancel = () => {
    __clearTimeout(id)
    let reject = _timers[id]
    if (reject === rejectfun) {
      _clearTimer(id)
      if (f) {
        try {
          f(/* canceled */true)
        } catch (e) {
          console.error("uncaught exception in timer handler: " + (e.stack || e))
        }
      }
      reject(new TimerCancellation())
    } else {
      resolvefun()
    }
  }

  function wrapThenCatch(p) {
    let _then = p.then
    p.then = (resolve, reject) => {
      let p2 = _then.call(p, resolve, reject)
      p2.cancel = p.cancel
      wrapThenCatch(p2)
      return p2
    }

    let _catch = p.catch
    p.catch = fn => {
      let p2 = _catch.call(p, fn)
      p2.cancel = p.cancel
      wrapThenCatch(p2)
      return p2
    }
  }

  wrapThenCatch(p)

  return p
}


function _clearTimer(id) {
  if (id in _timers) {
    _timerDebug(id, `_clearTimer: #${id} ok`)
    delete _timers[id]
    if (_timerWaitPromise && Object.keys(_timers).length == 0) {
      _timerWaitPromise.resolve()
      _timerWaitPromise = null
    }
  } else {
    _timerDebug(id, `_clearTimer: #${id} not found`)
  }
}


function _setTimeout(f, duration) {
  if (this.canceled) { throw new Error("script canceled") }
  // let id = setTimeout(() => _wrapTimerFun(f, id, __clearTimeout), duration)
  var id = setTimeout(() => {
    if (id in _timers) {
      _clearTimer(id)
    }
    try {
      f()
    } catch (e) {
      _timerDebug(id, `exception in handler ${e}`)
      __clearTimeout(id)
      if (_timerWaitPromise) {
        _cancelAllTimers(e)
      }
      throw e
    }
  }, duration)
  _timerDebug(id, `setTimeout start`)
  _timers[id] = TIMER_KIND_TIMEOUT
  return id
}

function _setInterval(f, interval) {
  if (this.canceled) { throw new Error("script canceled") }
  var id = setInterval(() => {
    try {
      f()
    } catch (e) {
      _timerDebug(id, `exception in handler ${e}`)
      __clearInterval(id)
      _clearTimer(id)
      if (_timerWaitPromise) {
        _cancelAllTimers(e)
      }
      throw e
    }
  }, interval)
  _timerDebug(id, `setInterval start`)
  _timers[id] = TIMER_KIND_INTERVAL
  return id
}

function _clearTimeout(id) {
  _timerDebug(id, `clearTimeout`)
  __clearTimeout(id)
  _clearTimer(id)
}

function _clearInterval(id) {
  _timerDebug(id, `clearInterval`)
  __clearInterval(id)
  _clearTimer(id)
}


// animate(f :(t:number, startt:number)=>void|"STOP") :SAnimation
function animate(f) {
  var id
  var rejectfun
  let p = new Promise((resolve, reject) => {
    const startt = Date.now() / 1000
    id = setInterval(() => {
      try {
        if (f((Date.now() / 1000) - startt) === "STOP") {
          __clearInterval(id)
          _clearTimer(id)
          resolve()
        }
      } catch (e) {
        if (e === "STOP") {
          resolve()
          return
        }
        _timerDebug(`animate: #${id} exception in handler ${e}`)
        __clearInterval(id)
        _clearTimer(id)
        if (_timerWaitPromise) {
          _cancelAllTimers(e)
        }
        throw e
        reject(e)
      }
    }, 16)
    _timerDebug(id, `animate start`)
    _timers[id] = rejectfun = reject
  })
  p.cancel = () => {
    __clearInterval(id)
    let reject = _timers[id]
    if (reject === rejectfun) {
      _clearTimer(id)
      reject(new TimerCancellation())
    }
  }
  return p
}

// ------------------------------------------------------------------------------------------

// group from nodes
function group(nodes, parent, index) {
  return figma.group(nodes, parent || figma.currentPage, index)
}

const MIXED = figma.mixed

const env = {
  figma: figmaObject,

  assert,
  TimerCancellation,
  animate,

  // shorthand figma.PROP
  apiVersion:    figma.apiVersion,
  root:          figma.root,  // DEPRECATED; not in type defs
  viewport:      figma.viewport,
  MIXED,
  clientStorage: figma.clientStorage,

  group,  // DEPRECATED; not in type defs

  __html__:"", // always empty
}

// ------------------------------------------------------------------------------------------
// Nodes

// Note: exposed on env for DOM.kindToCons
env.nodeConstructors = {}
env.nodeConstructors["BooleanOperation"] = figma.createBooleanOperation
env.nodeConstructors["Component"] = figma.createComponent
env.nodeConstructors["Ellipse"] = figma.createEllipse
env.nodeConstructors["Frame"] = figma.createFrame
env.nodeConstructors["Line"] = figma.createLine
env.nodeConstructors["Page"] = figma.createPage
env.nodeConstructors["Polygon"] = figma.createPolygon
env.nodeConstructors["Rectangle"] = figma.createRectangle
env.nodeConstructors["Slice"] = figma.createSlice
env.nodeConstructors["Star"] = figma.createStar
env.nodeConstructors["Text"] = figma.createText
env.nodeConstructors["Vector"] = figma.createVector
env.nodeConstructors["PaintStyle"] = figma.createPaintStyle
env.nodeConstructors["TextStyle"] = figma.createTextStyle
env.nodeConstructors["EffectStyle"] = figma.createEffectStyle
env.nodeConstructors["GridStyle"] = figma.createGridStyle

// DEPRECATED
env.Vector = env.createVector


// Node type guards
const nodeTypeGuard = typename => n => {
  return n.type == typename
}
env.isBooleanOperation = n => n && n.type == "BOOLEAN_OPERATION"
env.isComponent        = n => n && n.type == "COMPONENT"
env.isDocument         = n => n && n.type == "DOCUMENT"
env.isEllipse          = n => n && n.type == "ELLIPSE"
env.isFrame            = n => n && n.type == "FRAME"
env.isGroup            = n => n && n.type == "GROUP"
env.isInstance         = n => n && n.type == "INSTANCE"
env.isLine             = n => n && n.type == "LINE"
env.isPage             = n => n && n.type == "PAGE"
env.isPolygon          = n => n && n.type == "POLYGON"
env.isRectangle        = n => n && n.type == "RECTANGLE" ; env.isRect = env.isRectangle
env.isSlice            = n => n && n.type == "SLICE"
env.isStar             = n => n && n.type == "STAR"
env.isText             = n => n && n.type == "TEXT"
env.isVector           = n => n && n.type == "VECTOR"
// SceneNode type guard
const shapeNodeTypes = {
  BOOLEAN_OPERATION:1,
  ELLIPSE:1,
  LINE:1,
  POLYGON:1,
  RECTANGLE:1,
  STAR:1,
  TEXT:1,
  VECTOR:1,
}
const sceneNodeTypes = {
  // Shapes
  BOOLEAN_OPERATION:1,
  ELLIPSE:1,
  LINE:1,
  POLYGON:1,
  RECTANGLE:1,
  STAR:1,
  TEXT:1,
  VECTOR:1,
  // +
  COMPONENT:1,
  FRAME:1,
  GROUP:1,
  INSTANCE:1,
  SLICE:1,
}
const containerNodeTypes = {
  DOCUMENT:1,
  PAGE:1,
  BOOLEAN_OPERATION:1,
  COMPONENT:1,
  FRAME:1,
  GROUP:1,
  INSTANCE:1,
}
env.isSceneNode = n => n && n.type in sceneNodeTypes
env.isShape = n => n && n.type in shapeNodeTypes
env.isContainerNode = n => n && n.type in containerNodeTypes

// Paint
env.isSolidPaint = p => p && p.type == "SOLID"
const gradientTypes = {
  GRADIENT_LINEAR:1,
  GRADIENT_RADIAL:1,
  GRADIENT_ANGULAR:1,
  GRADIENT_DIAMOND:1,
}
env.isGradient = p => p && p.type in gradientTypes

// Style
env.isPaintStyle  = s => s && s.type == "PAINT"
env.isTextStyle   = s => s && s.type == "TEXT"
env.isEffectStyle = s => s && s.type == "EFFECT"
env.isGridStyle   = s => s && s.type == "GRID"

// isImage(p :Paint|null|undefined) :p is ImagePaint
// isImage<N extends Shape=Shape>(n :N) :n is N
// isImage(n :BaseNode) :false
env.isImage = n => (
  n && (
    n.type == "IMAGE" ||
    ( n.type in shapeNodeTypes &&
      n.fills !== MIXED &&
      n.fills.some(v => v.type == "IMAGE" && v.visible && v.opacity > 0))
      // Note: Even though v.opacity may be undefined, the v.opacity>0 test works as expected.
  )
)

// current selection
env.selection = index => (
  index !== undefined ? (figma.currentPage.selection[index] || null)
                      : figma.currentPage.selection
)

// setSelection(n :BaseNode|null|undefined|ReadonlyArray<BaseNode|null|undefined>) :void
env.setSelection = n => {
  figma.currentPage.selection = (Array.isArray(n) ? n : [n]).filter(env.isSceneNode)
  return n
}

const kPaint = Symbol("paint")

class Color {
  constructor(r,g,b) {
    this.r = r
    this.g = g
    this.b = b
    this[kPaint] = null
  }
  withAlpha(a) {
    return new ColorWithAlpha(this.r, this.g, this.b, a)
  }
  get paint() {
    return this[kPaint] || (this[kPaint] = {
      type: "SOLID",
      color: this,
    })
  }
}

class ColorWithAlpha extends Color {
  constructor(r,g,b,a) {
    super(r,g,b)
    this.a = a
  }
  withoutAlpha() {
    return new Color(this.r, this.g, this.b)
  }
  get paint() {
    return this[kPaint] || (this[kPaint] = {
      type: "SOLID",
      color: this.withoutAlpha(),
      opacity: this.a
    })
  }
}

// colors
// hexstr should be in the format "RRGGBB", "RGB", "HH" or "H" (H for greyscale.)
// Examples: C800A1, C0A, CC
env.Color = (r, g, b, a) => {
  if (typeof r == "string") {
    // "RRGGBB", "RGB" or "HH"
    let s = r
    if (s.length == 6) {
      r = parseInt(s.substr(0,2), 16) / 255
      g = parseInt(s.substr(2,2), 16) / 255
      b = parseInt(s.substr(4,2), 16) / 255
    } else if (s.length == 3) {
      r = parseInt(s[0]+s[0], 16) / 255
      g = parseInt(s[1]+s[1], 16) / 255
      b = parseInt(s[2]+s[2], 16) / 255
    } else if (s.length < 3) {
      r = g = b = parseInt(s.length == 1 ? s+s : s, 16) / 255
    } else {
      throw new Error("invalid color format " + JSON.stringify(s))
    }
  } else {
    if (r > 1 || g > 1 || b > 1 || a > 1) {
      // Note: a>1 works even when a is undefined
      throw new Error("color values outside range [0-1]")
    }
  }
  return a === undefined ? new Color(r,g,b) : new ColorWithAlpha(r,g,b,a)
}

env.RGB = (r,g,b) => new Color(r,g,b)
env.RGBA = (r,g,b,a) => new ColorWithAlpha(r,g,b,a)
// env.RGB = (r,g,b,a) => (a === undefined ? {r,g,b} : {r,g,b,a})
// env.RGBA = (r,g,b,a) => ({r,g,b, a: a === undefined ? 1 : a})

env.BLACK   = new Color(0   , 0   , 0)
env.WHITE   = new Color(1   , 1   , 1)
env.GREY    = new Color(0.5 , 0.5 , 0.5) ; env.GRAY = env.GREY
env.RED     = new Color(1   , 0   , 0)
env.GREEN   = new Color(0   , 1   , 0)
env.BLUE    = new Color(0   , 0   , 1)
env.CYAN    = new Color(0   , 1   , 1)
env.MAGENTA = new Color(1   , 0   , 1)
env.YELLOW  = new Color(1   , 1   , 0)
env.ORANGE  = new Color(1   , 0.5 , 0)


// ------------------------------------------------------------------------------------------

env.scripter = {
  visualizePrint: true,

  close(message) {
    if (typeof figma != "undefined") {
      figma.closePlugin(message)
    } else if (typeof window != "undefined") {
      window.close()
    } else {
      throw new Error("can't close Scripter")
    }
  },

  onend() {},

  addEndCallback(f) {
    if (!this._onEndCallbacks) {
      this._onEndCallbacks = [f]
    } else {
      this._onEndCallbacks.push(F)
    }
  },

  removeEndCallback(f) {
    if (this._onEndCallbacks) {
      let i = this._onEndCallbacks.indexOf(f)
      if (i != -1) {
        this._onEndCallbacks.splice(i, 1)
      }
    }
  },
}

// ------------------------------------------------------------------------------------------

// visit traverses the tree represented by node, calling visitor for each node.
//
// If the visitor returns false for a node with children, that
// node's children will not be visited. This allows efficient searching
// where you know that you can skip certain branches.
//
// Note: visitor is not called for `node`.
//
// visit(node :ContainerNode|ReadonlyArray<ContainerNode>, visitor :NodePredicate) :Promise<void>
function visit(node, visitor) {
  return new Promise(resolve => {
    let branches = Array.isArray(node) ? node.slice() : [node]
    function visitBranches() {
      let startTime = Date.now()
      while (true) {
        if (Date.now() - startTime > 100) {
          // we've locked the UI for a long time -- yield
          return setTimeout(visitBranches, 0)
        }
        let b = branches.shift()
        if (!b) {
          return resolve()
        }
        for (let n of b.children) {
          let r = visitor(n)
          if (r || r === undefined) {
            let children = n.children
            if (children) {
              branches.push(n)
            }
          }
        }
      }
    }
    visitBranches()
  })
}

// find traverses the tree represented by node and returns a list of all
// nodes for which predicate returns true.
//
// find(node :ContainerNode|ReadonlyArray<BaseNode>,
//      predicate :NodePredicate, options? :FindOptions) :Promise<BaseNode[]>
// find(predicate :NodePredicate, options? :FindOptions) :Promise<BaseNode[]>
function find(node, predicate, options) {
  if (typeof node == "function") {
    // find(predicate :NodePredicate, options? :FindOptions) :Promise<BaseNode[]>
    options = predicate
    predicate = node
    node = figma.currentPage
  }
  let results = []
  if (Array.isArray(node)) {
    node = node.filter(n => {
      if (n) {
        let r = predicate(n)
        if (r || r === undefined) {
          results.push(n)
          return n.type in containerNodeTypes
        }
      }
      return false
    })
  } else {
    node = [node]
  }
  return Promise.all(
    options && options.includeHidden ?
      node.map(n => visit(n, n => ((predicate(n) && results.push(n)), true) )) :
      node.map(n => visit(node, n => n.visible && ((predicate(n) && results.push(n)), true) ))
  ).then(() => results)
}


// findOne<R extends SceneNode>(
//   scope :FindScope|((n :SceneNode) => R|false),
//   predicate? :(n :SceneNode) => R|false,
// ) :R|null
function findOne(scope, predicate) {
  if (predicate === undefined) {
    predicate = scope
    scope = figma.currentPage
  }
  return scope.findOne(predicate)
}


env.visit = visit
env.find = find
env.findOne = findOne


// ------------------------------------------------------------------------------------------
// utilities

// declare function range(start :number, end :number, step? :number) :LazySequence<number>

// interface Iterator<T, TReturn = any, TNext = undefined> {
//     // NOTE: 'next' is defined using a tuple to ensure we report the correct assignability errors in all places.
//     next(...args: [] | [TNext]): IteratorResult<T, TReturn>;
// }


// range(start :number, end :number, step? :number) :LazySequence<number>
// range(end :number) :LazySequence<number>
env.range = function range(start, end, step) {
  if (end === undefined) {
    end = start
    start = 0
    step = 1
  } else if (step === undefined || step < 1) {
    step = 1
  }
  return new scriptLib.LazyNumberSequence(start, end, step)
}


env.addToPage = function add(node) {
  figma.currentPage.appendChild(node)
  return node
}

// ------------------------------------------------------------------------------------------
// Misc functions
// All defined in scriptLib and initialized at first call to evalScript

const F = function() {}
env.libui = F
env.libvars = F
env.DOM = F
env.createWorker = F
env.createWindow = F
env.timer = F // deprecated
env.Timer = F
env.setTimeout = F
env.setInterval = F
env.clearTimeout = F
env.clearInterval = F
env.withTimeout = F
// env.buildVector = F

env.fetchData = function(input, init) {
  return scriptLib.fetch(input, init).then(r => r.arrayBuffer()).then(b => new Uint8Array(b))
}

env.fetchText = function(input, init) {
  return scriptLib.fetch(input, init).then(r => r.text())
}

env.fetchJson = function(input, init) {
  return scriptLib.fetch(input, init).then(r => r.json())
}

env.fetchImg = function(input, init) {
  return env.fetchData(input, init).then(d => env.Img(d))
}

// ------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------
// end of env definition


let envKeys = [] // :string[]
let jsHeader = "", jsFooter = ""
let initialized = false

function initialize() {
  env.Img = scriptLib.Img
  env.Headers = scriptLib.Headers
  env.Response = scriptLib.Response
  env.Request = scriptLib.Request
  env.Path = scriptLib.Path
  env.fileType = scriptLib.fileType
  env.Bytes = scriptLib.Bytes
  env.libgeometry = scriptLib.libgeometry
  env.fetch = scriptLib.fetch
  // misc
  env.confirm = scriptLib.misc.confirm
  env.Base64 = scriptLib.misc.Base64
  env.createCancellablePromise = scriptLib.misc.createCancellablePromise
  scriptLib.initAnimateAPI(env.animate)
  scriptLib.initVectorNetworkAPI(env)
  scriptLib.initJSONAPI(env)

  // Node constructor keys
  env.createGroup = env.Group = F
  for (let nodeName in env.nodeConstructors) {
    env[nodeName] = F
    env["create" + nodeName] = F
  }

  envKeys = Object.keys(env)

  // Note: "__scripter_script_main" has special meaning: used to find stack start.
  //       "__scripter_script_main" used to be added here but is now added by the
  //       editor, in script.ts

  jsHeader = `
  var _, canceled=false, __onend, currentPage;
  function __oncurrentpagechange() { currentPage = figma.currentPage; }
  [
    function(module,exports,Symbol,__env,__print,__reqid,${envKeys.join(',')}){<LF>
      Object.defineProperty(scripter,"onend",{set:function(f){__onend=f}});
      currentPage = figma.currentPage;
      figma.on("currentpagechange", __oncurrentpagechange);
      function print() { __print(__env, __reqid, Array.prototype.slice.call(arguments)) }<LF>
      return`.trim().replace(/\n\s*/g, " ").replace(/<LF>/g, "\n")
  jsFooter = `
    },
    function(){ canceled = true },
    function(){ figma.off("currentpagechange", __oncurrentpagechange); return __onend }
  ]
  `.trim().replace(/\n\s*/g, " ")

  // Note: The following caused a memory-related crash in fig-js when user code
  // replaced one of the variables. For instance:
  //   function animate() {};animate()
  // would crash Figma.
  // This was replaced by a slightly slower and messier solution, which is to pass
  // every single item of the environment as a function argument.
  //
  // let names = Object.keys(env)  //.filter(k => k[0] != "_")
  // try {
  //   // @ts-ignore eval
  //   ;(0,eval)(`var {x,y} = {x:1,y:1}`)
  //   jsHeader += `const {${names.join(',')}} = __env;`
  // } catch (_) {
  //   jsHeader += "var " + names.map(k => `${k} = __env.${k}`).join(",") + ";"
  // }
  //

  // count lines that the source is offset, used for sourcemaps
  let i = 0, lineOffset = 0
  while (true) {
    i = jsHeader.indexOf("\n", i)
    if (i == -1) {
      break
    }
    i++ // skip past \n
    lineOffset++
  }
  // count lines that the source is offset, used for sourcemaps
  _evalScript.lineOffset = lineOffset

  initialized = true
}


function _evalScript(reqId, js) {
  if (!initialized) {
    initialize()
  }
  var cancelFun
  return [new Promise((resolve, reject) => {
    // // clean js
    // // "use strict";
    // // Object.defineProperty(exports, "__esModule", { value: true });
    // const expectHeader1 = '"use strict";\n'
    // const expectHeader2 = 'Object.defineProperty(exports, "__esModule", { value: true });\n'
    // if (DEBUG) {
    //   console.log("--------- script code --------\n" + js + "\n-----------------------------\n")
    //   // sanity checks for when typescript or monaco are upgraded and tested
    //   if (js.substr(0, expectHeader1.length) != expectHeader1) {
    //     console.warn("scripter-eval UNEXPECTED header1", {
    //       expect: expectHeader1,
    //       actual: js.substr(0, expectHeader1.length)
    //     })
    //   }
    //   if (js.substr(expectHeader1.length, expectHeader2.length) != expectHeader2) {
    //     console.warn("scripter-eval UNEXPECTED header2")
    //   }
    // }
    // js = js.substr(expectHeader1.length + expectHeader2.length)

    // eval
    js = jsHeader + js + "\n" + jsFooter
    dlog("evalScript\n" + js)
    let r = null
    try {
      // @ts-ignore eval (indirect call means scope is global)
      r = (0,eval)(js);
    } catch(e) {
      return reject(e)
    }

    // bindenv wraps a function to set `this` to env0.
    // We can't use bind() since that is not supported by fig-js.
    let bindenv = v => function() { return v.apply(env0, arguments) }

    // create invocation-specific environment
    let env0 = Object.assign({}, env, {
      canceled: false,
      timer:         bindenv(Timer), // deprecated
      Timer:         bindenv(Timer),
      withTimeout:   bindenv(scriptLib.misc.withTimeout),
      setTimeout:    bindenv(_setTimeout),
      setInterval:   bindenv(_setInterval),
      clearTimeout:  bindenv(_clearTimeout),
      clearInterval: bindenv(_clearInterval),
    })
    env0.scripter = Object.assign({}, env.scripter)
    env0.DOM = new scriptLib.DOM(env0)

    // Node constructors (depends on DOM)
    env0.createGroup = env0.Group = function() {
      return env0.DOM.createGroup.apply(env0.DOM, arguments)
    }
    for (let nodeName in env.nodeConstructors) {
      let cons = env.nodeConstructors[nodeName]
      let f = function create__NODE(props, ...children) {
        return env0.DOM.createElementv(cons, props, children, /*oncanvas*/true)
      }
      env0[nodeName] = f
      env0["create" + nodeName] = f
      env0.nodeConstructors[nodeName] = f
    }

    scriptLib.initVectorNetworkAPI(env0) // uses node constructors
    env0.libui = scriptLib.create_libui(reqId)
    env0.libvars = scriptLib.create_libvars(env0.libui)
    env0.viewport = createViewportAPI(env0, reqId)
    env0.animate = createAnimateAPI(env0, reqId)
    env0.createWorker = scriptLib.createCreateWorker(env0, reqId)
    env0.createWindow = function createWindow(a,src) {
      let title = "Window"
      if (src === undefined) {
        return env0.createWorker({ iframe: { visible: true, title } }, a)
      }
      let iframe = Object.assign({ title }, a)
      iframe.visible = true
      return env0.createWorker({ iframe }, src)
    }

    // onend function, guaranteed to be called at script end, including error.
    // must not throw
    let _onend = r[2]
    let ended = false  // dedupe in case its called multiple times
    function onend() {
      if (ended) {
        return
      }
      ended = true
      try {
        let userfun = _onend()
        if (userfun) {
          try {
            userfun()
          } catch (err) {
            console.warn("uncaught exception in scripter.onend: " + (err.stack || err))
          }
        }
        if (env0.scripter._onEndCallbacks) {
          for (let f of env0.scripter._onEndCallbacks) {
            try { f() } catch (e) { console.error("error in env.onend(): " + (e.stack || e)) }
          }
        }
      } catch (err) {
        console.error("error in env.onend(): " + (err.stack || err))
      }
    }

    // create script cancel function
    let cancelInner = r[1]
    cancelFun = reason => {
      env0.canceled = true
      cancelInner()
      _cancelAllTimers(reason || new Error("cancel"))
      onend()
      if (reason) {
        reject(reason)
      } else {
        resolve(reason)
      }
    }

    // arguments for script entry function
    let _module = {id:"",exports:{}}
    let params = [
      _module,          // module
      _module.exports,  // exports
      Symbol,           // Symbol
      env0,             // __env
      _print,           // __print
      reqId,            // __reqId
    ].concat(envKeys.map(k => env0[k]))
    // Note: Important to use envKeys here; same as we use for order of
    // argument names in jsHeader.

    try {
      // call script entry function and handle reply
      return r[0].apply(env0, params)
        .then(result =>
          _awaitAsync().then(() => {
            onend()
            resolve(result)
          })
        )
        .catch(e => {
          try { _cancelAllTimers(e) } catch(_) {}
          onend()

          // scripterStack is a work-around for limitations in fig-js
          let e2 = new Error()
          let stack = e.stack
          if (stack.substr(0, e.message.length) != e.message) {
            // fig-js (usually?) doesn't include message in stack trace. Fix that.
            stack = e.message + "\n" + stack
          }
          e2.message = e.message
          e2.scripterStack = stack
          e2.stack = stack

          reject(e2)
        })
    } catch(e) {
      _cancelAllTimers(e)
      onend()
      reject(e)
    }
  }), cancelFun]
}


return _evalScript
})();
