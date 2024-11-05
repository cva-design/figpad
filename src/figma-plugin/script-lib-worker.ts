import { ScriptEnv, scriptenv } from "./scriptenv"
import { rpc, sendMsg } from "./rpc"
import {
  WorkerCreateRequestMsg, WorkerCreateResponseMsg,
  WorkerMessageMsg, WorkerErrorMsg, WorkerCtrlMsg,
  WorkerSetFrameMsg,
} from "../common/messages"

type FigpadWorkerFun = scriptenv.FigpadWorkerFun
type FigpadWorkerError = scriptenv.FigpadWorkerError
type FigpadCreateWorkerOptions = scriptenv.FigpadCreateWorkerOptions
type FigpadTransferable = scriptenv.FigpadTransferable
type FigpadWindowedWorker = scriptenv.FigpadWindowedWorker

interface FigpadWorker extends scriptenv.FigpadWindowedWorker {
  _onmessage(msg :WorkerMessageMsg) :void
  _onerror(err :FigpadWorkerError) :void
  _onclose() :void
  _cancel(reason :string) :void  // sets error to reason and calls terminate
}


let workerIdGen = 0


// workerMap contains all workers
const workerMap = new Map<string,FigpadWorker>()  // workerId => Worker


// called by plugin onmessage dispatch when a worker message is sent from the app
export function handleIncomingMessage(msg :any) {
  let workerId = msg.workerId as string
  let worker = workerMap.get(workerId)
  if (!worker) {
    // this happens naturally for close & terminate messages, as close & terminate
    // are naturally racey.
    dlog(`plugin/worker recv message for non-existing worker#${workerId}:`, msg)
    return
  }

  switch (msg.type) {

  case "worker-message":
    worker._onmessage(msg as WorkerMessageMsg)
    break

  case "worker-error": {
    let m = msg as WorkerErrorMsg
    worker._onerror({
      colno: m.error.colno,
      error: m.error.error,
      filename: m.error.filename,
      lineno: m.error.lineno,
      message: m.error.message,
    })
    break
  }

  case "worker-ctrl": {
    let m = msg as WorkerCtrlMsg
    if (m.signal == "close") {
      // worker closed
      worker._onclose()
      break
    }
    console.error("plugin/worker got unexpected control message: " +
      JSON.stringify(msg, null, 2))
    break
  }

  default:
    console.warn(`plugin/worker recv unexpected message`, msg)
  }
}


class _WorkerError extends Error implements FigpadWorkerError {
  constructor(init? :FigpadWorkerError) {
    super()
    if (init) {
      for (let k in init) {
        ;(this as any)[k] = init[k]
      }
    }
    this.name = "FigpadWorkerError"
  }
}


const kWorkerId = Symbol("workerId")

// special props on data for implementing script-worker requests
// IMPORTANT: Keep in sync with worker-template.js
const requestIdProp = "__figpadRequestId"
const requestErrProp = "__figpadRequestError"


export function createCreateWorker(env :ScriptEnv, scriptId :string) {

  let initialized = false
  let scriptEnded = false

  function init() {
    if (initialized) { return }
    initialized = true
    env.figpad.addEndCallback(onScriptEnd)
  }

  function onScriptEnd() {
    // when script ends, end all workers
    // note: copy values as w.terminate might call workerMap.delete
    scriptEnded = true
    dlog(`createCreateWorker/onScriptEnd terminating ${workerMap.size} workers`)
    for (let w of Array.from(workerMap.values())) {
      dlog(`createCreateWorker/onScriptEnd terminate Worker#${w[kWorkerId]}`)
      w._cancel("script stopped")
    }
    workerMap.clear()
  }

  return function createWorker(
    arg0  :FigpadCreateWorkerOptions | undefined | string | FigpadWorkerFun,
    arg1? :string | FigpadWorkerFun,
  ) :FigpadWorker {
    if (scriptEnded) {
      console.log(`ignoring createWorker call after script has been stopped`)
      return Promise.reject(new Error("script stopped")) as any as FigpadWorker
    }

    init()

    let script :string | FigpadWorkerFun = arg1 || (arg0 as string | FigpadWorkerFun)
    let opt :FigpadCreateWorkerOptions = (
      arg1 && arg0 ? (arg0 as FigpadCreateWorkerOptions) : {}
    )

    const workerId = scriptId + "." + (workerIdGen++).toString(36)
    const eventOrigin = `figpad-worker:${workerId}`

    let js = script.toString()
    let sendq :{data:any,transfer?:FigpadTransferable[]}[] = []
    let recvp :Promise<any>|null = null
    let recvr = { resolve: (m:any)=>{}, reject: (reason?:any)=>{} }
    let terminated = false
    let closed = false
    let lastError :FigpadWorkerError|null = null
    let requestIdGen = 0
    const requests = new Map<string,{ resolve:any, reject:any, timer:any }>()

    function checkTerminated() {
      if (terminated) {
        throw new Error("worker terminated")
      }
    }

    // create FigpadWorker object
    let workerPromiseResolve :()=>void
    let workerPromiseReject :(reason? :any)=>void
    let w = new Promise<void>((resolve, reject) => {
      workerPromiseResolve = resolve
      workerPromiseReject = reject
    }) as any as FigpadWorker

    w[kWorkerId] = workerId

    w.postMessage = (data :any, transfer?: FigpadTransferable[]) => {
      checkTerminated()
      sendq.push({ data, transfer })
    }
    w.send = (data :any, transfer?: FigpadTransferable[]) => {
      w.postMessage(data, transfer)
    }
    w.recv = () :Promise<any> => {
      checkTerminated()
      if (!recvp) {
        recvp = new Promise((resolve, reject) => ( recvr = { resolve, reject } ))
      }
      return recvp
    }
    w.request = (data :any, arg1?: number|FigpadTransferable[], arg2? :number) :Promise<any> => {
      let transfer: undefined|FigpadTransferable[]
      let timeout :number = 0
      if (arg2 !== undefined) {
        transfer = arg1 as undefined|FigpadTransferable[]
        timeout = arg2
      } else if (typeof arg1 == "number") {
        timeout = arg1 as number
      }

      return new Promise<any>((resolve, reject) => {
        const requestId = scriptId + "." + (requestIdGen++).toString(36)
        w.postMessage({ [requestIdProp]: requestId, data }, transfer)
        let timer :any = null
        if (timeout && timeout > 0) {
          timer = setTimeout(() => { reject(new Error("timeout")) }, timeout)
        }
        dlog(`script send worker request ${requestId}`)
        requests.set(requestId, { resolve, reject, timer })
      })
    }

    w.terminate = () => {
      dlog("worker/terminate req")
      w._onclose()
      terminated = true
      if (workerMap.delete(workerId)) {
        dlog("worker/terminate exec")
        dlog(`[worker] terminating worker#${workerId}`)
        sendMsg<WorkerCtrlMsg>({
          type: "worker-ctrl",
          signal: "terminate",
          workerId,
        })
      }
      return w
    }

    // FigpadWindowedWorker methods
    if (opt.iframe && typeof opt.iframe == "object" && opt.iframe.visible) {
      w.setFrame = (x :number, y :number, width :number, height :number) :void => {
        sendMsg<WorkerSetFrameMsg>({ type:"worker-setFrame", workerId, x, y, width, height })
      }
      w.close = w.terminate
    }


    // internal methods, exposed for handleIncomingMessage
    w._cancel = (reason :string) => {
      if (!lastError) {
        lastError = new _WorkerError({ message: reason })
      }
      w.terminate()
    }

    w._onmessage = (msg :WorkerMessageMsg) => {
      if (terminated) {
        return
      }
      if (msg.evtype == "message") {

        const data = msg.data
        if (data !== null && typeof data == "object") {
          const requestId = data[requestIdProp]
          if (requestId !== undefined) {
            dlog("script got a response from a w.request() call", data, requestId)
            const r = requests.get(requestId) // { resolve, reject, timer }
            if (r) {
              clearTimeout(r.timer)
              const err = data[requestErrProp]
              if (err) {
                r.reject(new Error(String(err)))
              } else {
                r.resolve(data.data)
              }
            }
            return
          }
        }

        if (w.onmessage) {
          ;(w as any).onmessage({
            type: "message",
            data: data,
            origin: eventOrigin,
          })
        }
        if (recvp) {
          recvp = null
          recvr.resolve(msg.data)
        }
      } else {
        if (w.onmessageerror) {
          ;(w as any).onmessageerror({
            type: "messageerror",
            data: msg.data,
            origin: eventOrigin,
          })
        }
        if (recvp) {
          recvp = null
          recvr.reject(msg.data)
        }
      }
    }
    w._onerror = (err :FigpadWorkerError) => {
      lastError = new _WorkerError(err)
      if (w.onerror) {
        w.onerror(lastError)
      }
    }
    w._onclose = () => {
      if (closed) {
        dlog(`Worker#${workerId} onclose -- already closed`)
        return
      }
      dlog(`Worker#${workerId} onclose`)
      closed = true
      terminated = true
      if (recvp) {
        // reject waiting recv() calls
        recvp = null
        recvr.reject(lastError || new Error("worker closed"))
      }
      if (w.onclose) {
        w.onclose()
      }
      if (lastError) {
        workerPromiseReject(lastError)
      } else {
        workerPromiseResolve()
      }
    }

    // register new worker
    workerMap.set(workerId, w)

    dlog(`script requesting create Worker#${workerId}`)

    // sed request to UI
    rpc<WorkerCreateRequestMsg, WorkerCreateResponseMsg>(
      "worker-create-req", "worker-create-res",
    {
      workerId,
      js,
      iframe: opt.iframe,
    }).then(res => {
      dlog(`Worker#${workerId} created`, res)

      if (terminated) {
        // worker terminated already
        dlog(`[worker] note: worker#${workerId} terminated before it started`)
        return
      }

      if (w.onerror && res.error) {
        w.onerror(new _WorkerError(res.error))
        w.terminate()
        return
      }

      w.postMessage = (data :any, transfer?: FigpadTransferable[]) => {
        checkTerminated()
        sendMsg<WorkerMessageMsg>({
          type: "worker-message",
          evtype: "message",
          workerId,
          data,
          // Note: Figma API does not (yet) support transfer
        })
      }

      // send buffered messages
      for (let ent of sendq) {
        w.postMessage(ent.data, ent.transfer)
      }
      sendq = []
    }).catch(err => {
      console.error(`createWorker: ${err.stack||err}`)
      if (w.onerror) {
        ;(w as any).onerror(new _WorkerError(err))
      }
    })

    return w
  }
}
