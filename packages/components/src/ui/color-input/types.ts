// Adapted from https://mapseekai.github.io/mapseek-ui/r/color-input.json
import type { CSSProperties, ReactNode } from "react"

export type ColorInputMode = "button" | "button-input" | "input"
export type ColorInputLayout = "swatch-input" | "input-swatch"

export type ColorInputPopoverOpenChangeDetails = {
  reason?: string
  event?: Event
  cancel?: () => void
}

export type ColorInputRenderPickerContext = {
  value: string
  close: () => void
}

export type ColorInputProps = {
  id?: string
  "aria-invalid"?: boolean
  value?: string
  defaultValue?: string
  name?: string
  style?: CSSProperties
  mode?: ColorInputMode
  layout?: ColorInputLayout
  open?: boolean
  disabled?: boolean
  inputPlaceholder?: string
  swatchLabel?: string
  "aria-label"?: string
  onOpenChange?: (open: boolean, details?: ColorInputPopoverOpenChangeDetails) => void
  onTextChange?: (value: string) => void
  onPickerChange?: (value: unknown, formatted?: string) => void
  onTextFocus?: () => void
  onTextBlur?: () => void
  renderPicker?: (context: ColorInputRenderPickerContext) => ReactNode
}
