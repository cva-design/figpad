import React, { useState, useRef, useEffect, useCallback } from "react"
import ReactDOM from "react-dom"
import { Script } from "./script"
import { db } from "./data"
import { scriptsData } from "./script-data"
import { exportAllScripts } from "./script-export"
import { editor } from "./editor"
import { EventEmitter } from "./event"
import { config } from "./config"
import { dlog, isMac } from "./util"
import { WindowSize } from "../common/messages"


function scrollIntoView(e :HTMLElement) {
  if ((e as any).scrollIntoViewIfNeeded) {
    ;(e as any).scrollIntoViewIfNeeded()
  } else {
    e.scrollIntoView()
  }
}


interface MenuEvents {
  "visibility": boolean
}

class Menu extends EventEmitter<MenuEvents> {
  readonly isVisible = false

  _uiel = document.getElementById('menu')


  _resolveMenuUIMountPromise :(()=>void)|null
  menuUIMountPromise = new Promise<void>(resolve => {
    this._resolveMenuUIMountPromise = resolve
  })


  closeOnSelection = false


  toggle(closeOnSelection :bool = false) {
    ;(this as any).isVisible = this._uiel.classList.toggle("visible", !this.isVisible)
    document.body.classList.toggle("menuVisible", this.isVisible)
    this.closeOnSelection = closeOnSelection
    if (this.isVisible) {
      ReactDOM.render(<MenuUI />, this._uiel)
    } else if (editor.editor) {
      editor.editor.focus()
    }
    this.triggerEvent("visibility", this.isVisible)
    if (editor.editor) {
      editor.editor.layout()
    }
    config.menuVisible = this.isVisible
  }

  init() {
    if (config.menuVisible) {
      this.toggle()
    }
  }

  scrollToActiveItem() {
    function focusActiveItem() :boolean {
      let activeItem = document.querySelector("#menu .active") as HTMLElement|null
      if (!activeItem) {
        return false
      }
      scrollIntoView(activeItem)
      return true
    }
    if (!focusActiveItem()) {
      requestAnimationFrame(focusActiveItem)
    }
  }

}


export const menu = new Menu()


interface MenuProps {}
interface MenuState {
  scripts :Script[]
  exampleScripts :{[category:string]:Script[]}
  referenceScripts :Script[]
  currentScriptId :number
  configVersion :number
  isExportingScripts :boolean
}

export class MenuUI extends React.Component<MenuProps,MenuState> {

  constructor(props :MenuProps) {
    super(props)
    this.state = {
      scripts: scriptsData.scripts,
      exampleScripts: scriptsData.exampleScripts,
      referenceScripts: scriptsData.referenceScripts,
      currentScriptId: editor.currentScriptId,
      configVersion: config.version,
      isExportingScripts: false,
    }
  }

  // onNewScript = () => {
  //   editor.newScript({ name: scriptsData.nextNewScriptName() })
  // }

  scriptsDataChangeCallback = () => {
    this.setState({
      scripts: scriptsData.scripts,
      currentScriptId: editor.currentScriptId,
    })
  }

  onEditorModelChange = () => {
    this.setState({ currentScriptId: editor.currentScriptId })
  }

  onConfigChange = () => {
    this.setState({ configVersion: config.version })
  }

  componentDidMount() {
    // menu._setUI(this)
    scriptsData.on("change", this.scriptsDataChangeCallback)
    editor.on("modelchange", this.onEditorModelChange)
    config.on("change", this.onConfigChange)
    menu._resolveMenuUIMountPromise()
    menu._resolveMenuUIMountPromise = null
  }

  componentWillUnmount() {
    scriptsData.removeListener("change", this.scriptsDataChangeCallback)
    editor.removeListener("modelchange", this.onEditorModelChange)
    config.removeListener("change", this.onConfigChange)
    // menu._setUI(null)
  }

  onChangeSettingBool = (ev :any) => {
    ev.persist()
    let input = ev.target as HTMLInputElement
    const configPrefix = "config."
    if (input.name.startsWith(configPrefix)) {
      let value :any = input.type == "checkbox" ? input.checked : input.value
      ;(config as any)[input.name.substr(configPrefix.length)] = !!value
    }
  }

  onChangeSettingBoolNeg = (ev :any) => {
    ev.persist()
    let input = ev.target as HTMLInputElement
    const configPrefix = "config."
    if (input.name.startsWith(configPrefix)) {
      let value :any = input.type == "checkbox" ? input.checked : input.value
      ;(config as any)[input.name.substr(configPrefix.length)] = !value
    }
  }

  onChangeSettingPercent = (ev :any) => {
    ev.persist()
    let input = ev.target as HTMLInputElement
    const configPrefix = "config."
    if (input.name.startsWith(configPrefix)) {
      let value = parseFloat(input.value)
      if (!isNaN(value)) {
        ;(config as any)[input.name.substr(configPrefix.length)] = (Math.round(value) / 100)
      }
    }
  }

  onChangeSettingNum = (ev :any) => {
    ev.persist()
    let input = ev.target as HTMLInputElement
    const configPrefix = "config."
    if (input.name.startsWith(configPrefix)) {
      let value = parseFloat(input.value)
      if (!isNaN(value)) {
        ;(config as any)[input.name.substr(configPrefix.length)] = value
      }
    }
  }

  onChangeWindowSize = (ev :any) => {
    let s = ev.target.value.split(",")
    if (s.length > 1) {
      let ws :[WindowSize,WindowSize] = [
        WindowSize[s[0]] as unknown as WindowSize,
        WindowSize[s[1]] as unknown as WindowSize,
      ]
      if (ws) {
        config.windowSize = ws
      }
    }
  }

  onExportAllScripts = (ev :any) => {
    dlog("onExportAllScripts")
    this.setState({ isExportingScripts: true })
    exportAllScripts().then(() => {
      this.setState({ isExportingScripts: false })
    }).catch(err => {
      console.error(`failed to export scripts: ${err.stack||err}`)
      this.setState({ isExportingScripts: false })
    })
  }

  render() {
    // TODO: consider adding a button to "Reset defaults..." that deletes the database.
    const state = (this as any).state as MenuState // fix for IDE type issues
    let currentScriptId = state.currentScriptId
    let windowSizeVal = config.windowSize.map(v => WindowSize[v]).join(",")

    let examples = <div className="examples">
      {Object.keys(state.exampleScripts).map(cat =>
        <div key={cat} className="category">
          {cat ? <h4>{cat}</h4> : <h3>Examples</h3>}
          <ul>
            {state.exampleScripts[cat].map(s =>
              <MenuItem key={s.id} script={s} isActive={currentScriptId == s.id} />
            )}
          </ul>
        </div>
      )}
    </div>

    return (
    <div>
      {state.scripts.length > 0 ?
        <ul>
        {state.scripts.map(s =>
          <MenuItem key={s.id} script={s} isActive={currentScriptId == s.id} />
        )}
        </ul> :
        null
      }
      {examples}
      <h3>API reference</h3>
      <ul>
      {state.referenceScripts.map(s =>
        <MenuItem key={s.id} script={s} isActive={currentScriptId == s.id} /> )}
      </ul>
      <h3>Settings</h3>
      <div className="settings">
        <label>
          <input type="checkbox"
                 name="config.showLineNumbers"
                 checked={config.showLineNumbers}
                 onChange={this.onChangeSettingBool} />
          Line numbers
        </label>
        <label>
          <input type="checkbox"
                 name="config.wordWrap"
                 checked={config.wordWrap}
                 onChange={this.onChangeSettingBool} />
          Word wrap
        </label>
        <label title="Use the font JetBrains Mono instead of iA Writer Quattro">
          <input type="checkbox"
                 name="config.monospaceFont"
                 checked={config.monospaceFont}
                 onChange={this.onChangeSettingBool} />
          Monospace font
        </label>
        <label
          className={"dependant" + (config.monospaceFont ? "" : " disabled")}
          title="Enables fancy ligatures of the monospace font JetBrains Mono, like special glyphs for => and ==">
          <input type="checkbox"
                 name="config.fontLigatures"
                 checked={config.fontLigatures}
                 onChange={this.onChangeSettingBool} />
          Font ligatures
        </label>
        <label title="Visualize otherwise-invisible characters like spaces and tabs">
          <input type="checkbox"
                 name="config.showWhitespace"
                 checked={config.showWhitespace}
                 onChange={this.onChangeSettingBool} />
          Show whitespace
        </label>
        <label title="Show vertical indentation guides">
          <input type="checkbox"
                 name="config.indentGuides"
                 checked={config.indentGuides}
                 onChange={this.onChangeSettingBool} />
          Indentation guides
        </label>
        <label title="Enables a minimap for navigating large scripts">
          <input type="checkbox"
                 name="config.minimap"
                 checked={config.minimap}
                 onChange={this.onChangeSettingBool} />
          Minimap
        </label>
        <label title="Enables information cards shown when hovering over code snippets">
          <input type="checkbox"
                 name="config.hoverCards"
                 checked={config.hoverCards}
                 onChange={this.onChangeSettingBool} />
          Hover cards
        </label>
        <label title="Enables suggestions as you type">
          <input type="checkbox"
                 name="config.quickSuggestions"
                 checked={config.quickSuggestions}
                 onChange={this.onChangeSettingBool} />
          Quick suggestions
        </label>
        <label className={"dependant" + (config.quickSuggestions ? "" : " disabled")}>
          <div className="icon delay" title="Quick suggestions delay" />
          <input type="number"
                 step="100"
                 min="0" max="10000"
                 readOnly={!config.quickSuggestions}
                 name="config.quickSuggestionsDelay"
                 value={config.quickSuggestionsDelay}
                 onChange={this.onChangeSettingNum} />
           <span>ms</span>
        </label>

        <label title="Pressing the TAB key inserts SPACE characters instead of TAB">
          <input type="checkbox"
                 name="config.useTabs"
                 checked={!config.useTabs}
                 onChange={this.onChangeSettingBoolNeg} />
          TAB inserts spaces
        </label>
        <label>
          Tab size:
          <input type="number"
                 step="1"
                 min="1" max="8"
                 name="config.tabSize"
                 value={config.tabSize}
                 onChange={this.onChangeSettingNum} />
        </label>
        <label title="Size of Figpad window">
          <div className="icon window" />
          <select name="config.windowSize" value={windowSizeVal} onChange={this.onChangeWindowSize}>
          <option disabled={true}>Window W×H</option>
          <option value={"SMALL,SMALL"}  >S×S  window</option>
          <option value={"SMALL,MEDIUM"} >S×M  window</option>
          <option value={"SMALL,LARGE"}  >S×L  window</option>
          <option value={"SMALL,XLARGE"} >S×MAX window</option>

          <option value={"MEDIUM,SMALL"} >M×S  window</option>
          <option value={"MEDIUM,MEDIUM"}>M×M  window</option>
          <option value={"MEDIUM,LARGE"} >M×L  window</option>
          <option value={"MEDIUM,XLARGE"}>M×MAX window</option>

          <option value={"LARGE,SMALL"}  >L×S  window</option>
          <option value={"LARGE,MEDIUM"} >L×M  window</option>
          <option value={"LARGE,LARGE"}  >L×L  window</option>
          <option value={"LARGE,XLARGE"} >L×MAX window</option>

          <option value={"XLARGE,SMALL"}  >XL×S   window</option>
          <option value={"XLARGE,MEDIUM"} >XL×M   window</option>
          <option value={"XLARGE,LARGE"}  >XL×L   window</option>
          <option value={"XLARGE,XLARGE"} >XL×MAX window</option>
          </select>
        </label>
        <label
          title={`Scale of the Figpad editor text size (${isMac ? "⌘+/-" : "Ctrl+/-"})`}
          >
          <div className="icon text-size" />
          {/* Note: Sync min & max with values in app.ts uiScaleSteps */}
          <input type="number"
                 step="10"
                 min="50" max="300"
                 name="config.uiScale"
                 value={Math.round(config.uiScale * 100)}
                 onChange={this.onChangeSettingPercent} />
           <span>%</span>
        </label>
        <div className="group extra-actions">
          <button disabled={state.isExportingScripts}
                  onClick={state.isExportingScripts ? ()=>{} : this.onExportAllScripts}
                  >{state.isExportingScripts ? "Exporting..." : "Export all scripts"}</button>
        </div>
      </div>
    </div>
    )
  }
}


interface MenuItemProps {
  script :Script
  isActive :boolean
}

function MenuItem(props :MenuItemProps) :JSX.Element {
  let s = props.script

  const [isEditing, setIsEditing] = useState(false)

  let attrs :{[k:string]:any} = {
    // tabIndex: 0,
    className: (
      (props.isActive ? "active" : "") +
      (s.id == 0 ? " unsaved" : "")
    ),
  }

  if (!isEditing) {
    function onMouseDown(ev :Event) {
      if (menu.closeOnSelection) {
        menu.toggle()
      }
      dlog("menu/open-script", s)
      editor.openScriptByGUID(s.guid)
      scrollIntoView(ev.target as HTMLElement)
    }
    attrs.onMouseDown = onMouseDown
    if (!s.isROLib && s.id >= 0) {
      // allow renaming of editable files which are either unsaved (id==0) or saved (id>0).
      // however, do not allow renaming of editable example files (id<0).
      attrs.onDoubleClick = ev => {
        setIsEditing(true)
        ev.preventDefault()
        ev.stopPropagation()
      }
      attrs.onContextMenu = ev => {
        setIsEditing(true)
        ev.preventDefault()
        ev.stopPropagation()
      }
      attrs.title = `Last modified ${s.modifiedAt.toLocaleString()}`
    }
  }

  function deleteScript() {
    let confirmMessage = `Delete script "${s.name}"?`
    if (s.isSavedInFigma()) {
      confirmMessage =
        `Remove script "${s.name}" from menu? You can open later again from Figma.`
    }
    if (s.id > 0 && confirm(confirmMessage)) {
      // TODO: move this logic to editor or maybe script-data?
      let otherScriptToOpen = scriptsData.scriptAfterOrBefore(s.guid)
      if (!otherScriptToOpen) {
        // deleted last script -- we must always have one script, so make a new one
        editor.newScript()
      } else {
        editor.openScriptByGUID(otherScriptToOpen.guid)
      }
      s.delete()
    }
  }

  let didCommitEditing = false

  function commitEditing(newName :string) :void {
    if (didCommitEditing) {
      return
    }
    didCommitEditing = true
    newName = newName.trim()
    if (newName.length == 0) {
      deleteScript()
    } else {
      // Note: Scripts which are unsaved are only created when the body is non-empty.
      // This means that if we create a new script, which starts out empty, and then
      // rename it, the name is saved only in memory and the script is not persisted
      // until some edit is done to the body.
      if (s.name != newName) {
        s.name = newName
        // even though setting the name implies scheduleSave, we save immediately
        // so that the UI updates quickly (e.g. window title.)
        s.save()
      }
    }
    setIsEditing(false)
  }
  function cancelEditing() :void {
    setIsEditing(false)
  }

  let valueProps :MenuItemValueProps = {
    name: s.name,
    isEditing,
    commitEditing,
    cancelEditing,
  }

  let buttons :JSX.Element[] = []

  if (!isEditing && !s.isROLib) {
    async function onClickPlayButton(ev :React.MouseEvent<HTMLDivElement>) {
      ev.preventDefault()
      ev.stopPropagation()
      await editor.openScriptByID(s.id)
      editor.runCurrentScript()
    }

    buttons = [
      // U+2009 THIN SPACE offsets U+25B6 BLACK RIGHT-POINTING TRIANGLE
      <MenuItemButton key="play" className="play" title={"\u2009▶"}
                      tooltip={props.isActive ? "Run script" : "Open & Run script"}
                      onClick={onClickPlayButton} />,
    ]

    if (s.id > 0) {
      async function onClickDeleteButton(ev :React.MouseEvent<HTMLDivElement>) {
        deleteScript()
      }
      buttons.unshift(
        <MenuItemButton key="delete" className="delete" title={"✗"}
                        tooltip="Delete script"
                        onClick={onClickDeleteButton} />
      )
    }
  }

  return (
    <li {...attrs}>
      <MenuItemValue {...valueProps} />
      {buttons}
    </li>
  )
}


interface MenuItemButtonProps {
  title     :string
  className :string
  tooltip?  :string
  onClick   :(e:React.MouseEvent<HTMLDivElement>)=>void
}

function MenuItemButton(props :MenuItemButtonProps) :JSX.Element {
  return <div
    className={"button " + props.className}
    onClick={props.onClick}
    title={props.tooltip}
    >{props.title}</div>
}



interface MenuItemValueProps {
  name        :string
  isEditing   :boolean
  commitEditing(newName :string) :void
  cancelEditing() :void
}

function MenuItemValue(props :MenuItemValueProps) :JSX.Element {
  const [editName, setEditName] = useState(props.name)
  const [needsSelectAll, setNeedsSelectAll] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!props.isEditing) {
      // reset edit-state values when not editing
      if (editName !== props.name) { setEditName(props.name) }
      if (!needsSelectAll) { setNeedsSelectAll(true) }
      return
    }
    if (needsSelectAll && inputRef.current) {
      inputRef.current.select()
      setNeedsSelectAll(false)
    }
  })

  if (!props.isEditing) {
    return <span className="name">{props.name}</span>
  }

  function onChange(ev) {
    setEditName(ev.target.value)
  }

  function onKeyDown(ev) {
    if (ev.key == "Enter") {
      props.commitEditing(editName)
      ev.preventDefault()
      ev.stopPropagation()
    } else if (ev.key == "Escape") {
      props.cancelEditing()
      ev.preventDefault()
      ev.stopPropagation()
    }
  }

  function onBlur() {
    props.commitEditing(editName)
  }

  return <input type="text" autoFocus
    {...{value: editName, ref: inputRef, onChange, onBlur, onKeyDown }} />
}
