// defined by library ../common/figpad-env.js
type EvalCancelFun = (reason?:Error)=>void
interface EvalScriptFun {
  (reqid :string, js :string) :[Promise<any>,EvalCancelFun]
  readonly lineOffset :number
}
declare const evalScript :EvalScriptFun
