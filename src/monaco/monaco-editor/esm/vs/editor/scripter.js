// copied to ./monaco-editor/esm/vs/editor/scripter.js by misc/update-monaco.sh
import { StandaloneServices } from './standalone/browser/standaloneServices.js'
import {
  ICodeEditorService
} from './browser/services/codeEditorService.js'
import { ILabelService } from '../platform/label/common/label.js'

function patchEditorService(openCodeEditor) {
  StandaloneServices.get(ICodeEditorService).openCodeEditor = openCodeEditor
}


function patchEditorModelResolverService(findModel) {
  // https://github.com/Microsoft/monaco-editor/issues/779#issuecomment-374258435
  StandaloneServices.get(ICodeEditorService).findModel = findModel
}


let _basenameOrAuthority = null
function patchBasenameOrAuthority(basenameOrAuthority) {
  _basenameOrAuthority = basenameOrAuthority
}
export function basenameOrAuthority(resource) {
  if (_basenameOrAuthority) {
    return _basenameOrAuthority(resource)
  }
}
export function getBaseLabel(resource) {
  return basenameOrAuthority(resource)
}


function patchUriLabelService(getUriLabel) {
  // returns a label for a resource.
  // Shows up as a tool tip and small text next to the filename
  StandaloneServices.get(ILabelService).getUriLabel = getUriLabel
}


window.__scripterMonaco = {
  patchEditorService,
  patchEditorModelResolverService,
  patchUriLabelService,
  patchBasenameOrAuthority,
}
