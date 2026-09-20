// Adapted from MapSeek UI: https://mapseekai.github.io/mapseek-ui/blocks/json-editor/
import { autocompletion } from "@codemirror/autocomplete"
import { json, jsonParseLinter } from "@codemirror/lang-json"
import {
  bracketMatching,
  foldGutter,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language"
import { linter, lintGutter } from "@codemirror/lint"
import { highlightSelectionMatches } from "@codemirror/search"
import { EditorState, type Extension } from "@codemirror/state"
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
} from "@codemirror/view"
import { tags } from "@lezer/highlight"
import CodeMirror from "@uiw/react-codemirror"
import stringifyPretty from "json-stringify-pretty-compact"
import { type CSSProperties, useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { cn } from "../../lib/utils"

type BuiltInJsonEditorTheme = "app" | "light" | "dark" | "none"

export type JsonEditorTheme = BuiltInJsonEditorTheme | Extension

type JsonEditorThemeVariables = CSSProperties & {
  [name in `--json-editor-${string}`]?: string
}

export interface JsonEditorProps {
  value: unknown
  text?: string
  onTextChange?(text: string): void
  readOnly?: boolean
  onChange(value: unknown): void
  title?: string | null
  ariaLabel?: string
  className?: string
  editorClassName?: string
  headerClassName?: string
  titleClassName?: string
  theme?: JsonEditorTheme
  onFocus?(): void
  onBlur?(): void
  withScroll?: boolean
  bordered?: boolean
}

const jsonEditorStructureTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.5",
  },
  ".cm-content": {
    minHeight: "100%",
    padding: "8px 0",
  },
  ".cm-line": {
    padding: "0 12px 0 8px",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "32px",
    padding: "0 8px 0 6px",
  },
  ".cm-foldGutter .cm-gutterElement": {
    padding: "0 5px",
  },
  ".cm-gutter-lint": {
    width: "2px",
  },
  ".cm-gutter-lint .cm-gutterElement": {
    minWidth: "2px",
    padding: "0",
    overflow: "hidden",
  },
  "&.cm-focused": {
    outline: "none",
  },
})

const jsonEditorColorSpec = {
  "&": {
    backgroundColor: "var(--json-editor-background)",
    color: "var(--json-editor-foreground)",
  },
  ".cm-content": { caretColor: "var(--json-editor-foreground)" },
  ".cm-gutters": {
    backgroundColor: "var(--json-editor-muted)",
    color: "var(--json-editor-muted-foreground)",
    borderRight: "1px solid var(--json-editor-border)",
  },
  ".cm-activeLine": { backgroundColor: "var(--json-editor-selection)" },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--json-editor-selection)",
    color: "var(--json-editor-foreground)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--json-editor-selection-mid)",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--json-editor-foreground)",
  },
  "&.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--json-editor-selection-deep)",
    outline: "1px solid var(--json-editor-primary)",
  },
  ".cm-tooltip": {
    border: "1px solid var(--json-editor-border)",
    backgroundColor: "var(--json-editor-popover)",
    color: "var(--json-editor-popover-foreground)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--json-editor-selection)",
    color: "var(--json-editor-foreground)",
  },
  ".cm-diagnostic-error": {
    borderLeftColor: "var(--json-editor-destructive)",
  },
  ".cm-lintRange-error": {
    backgroundImage:
      "linear-gradient(45deg, transparent 65%, var(--json-editor-destructive) 80%, transparent 90%)",
  },
}

const jsonEditorColorTheme = EditorView.theme(jsonEditorColorSpec)
const darkJsonEditorColorTheme = EditorView.theme(jsonEditorColorSpec, { dark: true })

const jsonEditorHighlightStyle = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.propertyName, color: "var(--json-editor-cat-1)" },
    { tag: tags.string, color: "var(--json-editor-cat-2)" },
    { tag: tags.number, color: "var(--json-editor-cat-3)" },
    { tag: tags.bool, color: "var(--json-editor-cat-4)" },
    { tag: tags.null, color: "var(--json-editor-muted-foreground)" },
    { tag: tags.punctuation, color: "var(--json-editor-muted-foreground)" },
  ]),
)

const jsonEditorThemeVariables: Record<
  Exclude<BuiltInJsonEditorTheme, "none">,
  JsonEditorThemeVariables
> = {
  app: {
    "--json-editor-background": "var(--background)",
    "--json-editor-foreground": "var(--foreground)",
    "--json-editor-muted": "var(--muted)",
    "--json-editor-muted-foreground": "var(--muted-foreground)",
    "--json-editor-shell-border": "var(--input)",
    "--json-editor-border": "var(--border)",
    "--json-editor-popover": "var(--popover)",
    "--json-editor-popover-foreground": "var(--popover-foreground)",
    "--json-editor-selection": "color-mix(in srgb, var(--primary) 8%, transparent)",
    "--json-editor-selection-mid": "color-mix(in srgb, var(--primary) 18%, transparent)",
    "--json-editor-selection-deep": "color-mix(in srgb, var(--primary) 28%, transparent)",
    "--json-editor-primary": "var(--primary)",
    "--json-editor-destructive": "var(--destructive)",
    "--json-editor-cat-1": "var(--primary)",
    "--json-editor-cat-2": "var(--success)",
    "--json-editor-cat-3": "var(--warning)",
    "--json-editor-cat-4": "var(--foreground)",
  },
  light: {
    "--json-editor-background": "#ffffff",
    "--json-editor-foreground": "#24292f",
    "--json-editor-muted": "#f6f8fa",
    "--json-editor-muted-foreground": "#57606a",
    "--json-editor-shell-border": "#afb8c1",
    "--json-editor-border": "#d0d7de",
    "--json-editor-popover": "#ffffff",
    "--json-editor-popover-foreground": "#24292f",
    "--json-editor-selection": "#ddf4ff",
    "--json-editor-selection-mid": "#b6e3ff",
    "--json-editor-selection-deep": "#80ccff",
    "--json-editor-primary": "#0969da",
    "--json-editor-destructive": "#cf222e",
    "--json-editor-cat-1": "#953800",
    "--json-editor-cat-2": "#116329",
    "--json-editor-cat-3": "#0550ae",
    "--json-editor-cat-4": "#8250df",
  },
  dark: {
    "--json-editor-background": "#0d1117",
    "--json-editor-foreground": "#e6edf3",
    "--json-editor-muted": "#161b22",
    "--json-editor-muted-foreground": "#8b949e",
    "--json-editor-shell-border": "#484f58",
    "--json-editor-border": "#30363d",
    "--json-editor-popover": "#161b22",
    "--json-editor-popover-foreground": "#e6edf3",
    "--json-editor-selection": "#1f3b57",
    "--json-editor-selection-mid": "#264f78",
    "--json-editor-selection-deep": "#315f89",
    "--json-editor-primary": "#58a6ff",
    "--json-editor-destructive": "#f85149",
    "--json-editor-cat-1": "#ffa657",
    "--json-editor-cat-2": "#7ee787",
    "--json-editor-cat-3": "#79c0ff",
    "--json-editor-cat-4": "#d2a8ff",
  },
} satisfies Record<Exclude<BuiltInJsonEditorTheme, "none">, JsonEditorThemeVariables>

const builtInThemeExtensions = {
  app: [jsonEditorColorTheme, jsonEditorHighlightStyle],
  light: [jsonEditorColorTheme, jsonEditorHighlightStyle],
  dark: [darkJsonEditorColorTheme, jsonEditorHighlightStyle],
} satisfies Record<Exclude<BuiltInJsonEditorTheme, "none">, Extension>

function resolveJsonEditorTheme(theme: JsonEditorTheme) {
  if (typeof theme !== "string") {
    return { name: "custom" as const, variables: undefined, extension: theme }
  }

  if (theme === "none") {
    return { name: theme, variables: undefined, extension: [] }
  }

  return {
    name: theme,
    variables: jsonEditorThemeVariables[theme],
    extension: builtInThemeExtensions[theme],
  }
}

function formatJsonValue(value: unknown) {
  return stringifyPretty(value === undefined ? {} : value, {
    indent: 2,
    maxLength: 40,
  })
}

export function JsonEditor({
  value,
  text,
  onTextChange,
  readOnly = false,
  onChange,
  title = null,
  ariaLabel = "JSON editor",
  className,
  editorClassName,
  headerClassName,
  titleClassName,
  theme = "app",
  onFocus,
  onBlur,
  withScroll = false,
  bordered = true,
}: JsonEditorProps) {
  const [code, setCode] = useState(() => formatJsonValue(value))
  const [isFocused, setIsFocused] = useState(false)
  const isFocusedRef = useRef(false)
  const formattedValueRef = useRef(code)
  const pendingFormattedValueRef = useRef<string | null>(null)
  const titleId = useId()
  const labelledBy = title !== null ? titleId : undefined
  const editorAriaLabel = title === null ? ariaLabel : undefined

  const formattedValue = useMemo(() => formatJsonValue(value), [value])
  const resolvedTheme = useMemo(() => resolveJsonEditorTheme(theme), [theme])
  const usesBuiltInPalette = resolvedTheme.variables !== undefined
  const extensions = useMemo(
    () => [
      jsonEditorStructureTheme,
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      indentOnInput(),
      bracketMatching(),
      autocompletion(),
      highlightSelectionMatches(),
      highlightActiveLine(),
      json(),
      lintGutter(),
      linter(jsonParseLinter()),
      resolvedTheme.extension,
      EditorView.contentAttributes.of(
        labelledBy ? { "aria-labelledby": labelledBy } : { "aria-label": ariaLabel },
      ),
      EditorState.tabSize.of(2),
      EditorView.lineWrapping,
    ],
    [ariaLabel, labelledBy, resolvedTheme],
  )

  useEffect(() => {
    isFocusedRef.current = isFocused
  }, [isFocused])

  useEffect(() => {
    if (text !== undefined) return
    if (formattedValueRef.current === formattedValue) {
      return
    }

    formattedValueRef.current = formattedValue
    pendingFormattedValueRef.current = formattedValue

    if (isFocused) {
      return
    }

    queueMicrotask(() => {
      if (isFocusedRef.current || formattedValueRef.current !== formattedValue) {
        return
      }

      pendingFormattedValueRef.current = null
      setCode((currentCode) => (currentCode === formattedValue ? currentCode : formattedValue))
    })
  }, [formattedValue, isFocused, text])

  useEffect(() => {
    if (text !== undefined) return
    if (isFocused || pendingFormattedValueRef.current === null) {
      return
    }

    const pendingFormattedValue = pendingFormattedValueRef.current
    queueMicrotask(() => {
      if (isFocusedRef.current || formattedValueRef.current !== pendingFormattedValue) {
        return
      }

      pendingFormattedValueRef.current = null
      setCode((currentCode) =>
        currentCode === pendingFormattedValue ? currentCode : pendingFormattedValue,
      )
    })
  }, [isFocused, text])

  const handleChange = useCallback(
    (nextCode: string) => {
      if (readOnly) return
      setCode(nextCode)
      onTextChange?.(nextCode)

      try {
        onChange(JSON.parse(nextCode))
      } catch {
        // Keep invalid in-progress JSON visible until the user fixes it.
      }
    },
    [onChange, onTextChange, readOnly],
  )

  const handleFocus = useCallback(() => {
    setIsFocused(true)
    onFocus?.()
  }, [onFocus])

  const handleBlur = useCallback(() => {
    setIsFocused(false)
    onBlur?.()
  }, [onBlur])

  return (
    <fieldset
      className={cn(
        "relative m-0 flex h-[360px] max-h-full min-h-0 w-full flex-col overflow-hidden border p-0",
        usesBuiltInPalette &&
          "border-(--json-editor-shell-border) bg-(--json-editor-background) text-(--json-editor-foreground)",
        withScroll && "h-full",
        !bordered && "border-0",
        className,
      )}
      style={resolvedTheme.variables}
      data-json-editor-theme={resolvedTheme.name}
      data-wd-key="json-editor"
      aria-label={editorAriaLabel}
      aria-labelledby={labelledBy}
    >
      {title !== null ? (
        <div
          className={cn(
            "flex h-8 shrink-0 items-center border-b px-3",
            usesBuiltInPalette && "border-(--json-editor-border) bg-(--json-editor-muted)",
            headerClassName,
          )}
        >
          <span
            id={titleId}
            className={cn(
              "font-mono text-label-sm leading-none uppercase",
              usesBuiltInPalette && "text-(--json-editor-muted-foreground)",
              titleClassName,
            )}
          >
            {title}
          </span>
        </div>
      ) : null}
      <div
        className={cn(
          "relative min-h-0 flex-1 overflow-hidden text-body-md",
          usesBuiltInPalette && "bg-(--json-editor-background) text-(--json-editor-foreground)",
          editorClassName,
        )}
      >
        <CodeMirror
          value={text ?? code}
          readOnly={readOnly}
          editable={!readOnly}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          theme="none"
          extensions={extensions}
          basicSetup={false}
          height="100%"
          className="h-full"
        />
      </div>
    </fieldset>
  )
}
