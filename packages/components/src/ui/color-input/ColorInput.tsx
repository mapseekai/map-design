// Adapted from https://mapseekai.github.io/mapseek-ui/r/color-input.json
"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { Button } from "../button"
import { Input } from "../input"
import { Popover, PopoverContent, PopoverTrigger } from "../popover"
import { cn } from "../../lib/utils"

import {
  ColorPicker,
  ColorPickerAlpha,
  ColorPickerEyeDropper,
  ColorPickerFormat,
  ColorPickerHue,
  ColorPickerOutput,
  ColorPickerSelection,
} from "./ColorPicker"
import type { ColorInputPopoverOpenChangeDetails, ColorInputProps } from "./types"

export function ColorInput({
  value,
  id,
  "aria-invalid": ariaInvalid,
  defaultValue = "#000000",
  name,
  style,
  mode = "button-input",
  layout = "swatch-input",
  open,
  disabled = false,
  inputPlaceholder,
  swatchLabel,
  "aria-label": ariaLabel,
  onOpenChange,
  onTextChange,
  onPickerChange,
  onTextFocus,
  onTextBlur,
  renderPicker,
}: ColorInputProps) {
  const reactId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const swatchRef = useRef<HTMLButtonElement>(null)
  const inputPointerStartedOpenRef = useRef(false)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const [internalValue, setInternalValue] = useState(defaultValue)
  const displayValue = value ?? internalValue
  const changeText = (nextValue: string) => {
    if (value === undefined) setInternalValue(nextValue)
    onTextChange?.(nextValue)
  }
  const isControlled = open !== undefined
  const isOpen = open ?? uncontrolledOpen
  const effectiveOpen = disabled ? false : isOpen
  const hasButton = mode === "button" || mode === "button-input"
  const hasInput = mode === "input" || mode === "button-input"

  const setOpen = useCallback(
    (nextOpen: boolean, details?: ColorInputPopoverOpenChangeDetails) => {
      if (disabled) {
        details?.cancel?.()
        return
      }

      if (!isControlled) setUncontrolledOpen(nextOpen)
      onOpenChange?.(nextOpen, details)
    },
    [disabled, isControlled, onOpenChange],
  )

  useEffect(() => {
    if (!effectiveOpen) return

    const ownerDocument = inputRef.current?.ownerDocument ?? swatchRef.current?.ownerDocument
    if (!ownerDocument) return

    const closeAfterOutsidePress = (event: MouseEvent) => {
      const target = event.target
      if (
        !(target instanceof Node) ||
        pickerRef.current?.contains(target) ||
        swatchRef.current?.contains(target)
      ) {
        return
      }

      setOpen(false)
    }

    ownerDocument.addEventListener("click", closeAfterOutsidePress)
    return () => ownerDocument.removeEventListener("click", closeAfterOutsidePress)
  }, [effectiveOpen, setOpen])

  const handlePickerChange = (nextValue: unknown, formatted?: string) => {
    if (onPickerChange) {
      onPickerChange(nextValue, formatted)
      return
    }

    const colorValue = formatPickerValue(nextValue, formatted)
    if (colorValue) changeText(colorValue)
  }

  const picker = renderPicker?.({
    value: displayValue,
    close: () => setOpen(false),
  }) ?? (
    <ColorPicker value={displayValue} onChange={handlePickerChange} className="w-64">
      <ColorPickerSelection className="h-48 w-full" />
      <div className="flex flex-col gap-2">
        <ColorPickerHue aria-label="H" />
        <ColorPickerAlpha aria-label="α" />
      </div>
      <div className="flex items-center gap-2">
        <ColorPickerOutput />
        <ColorPickerEyeDropper aria-label={swatchLabel ?? ariaLabel} />
      </div>
      <ColorPickerFormat />
    </ColorPicker>
  )

  const swatch = hasButton ? (
    <PopoverTrigger
      render={
        <Button
          ref={swatchRef}
          variant="ghost"
          size="icon-xs"
          type="button"
          disabled={disabled}
          aria-label={swatchLabel ?? ariaLabel ?? "Open color picker"}
          className="size-6 shrink-0 cursor-pointer border border-input bg-background"
          style={{ backgroundColor: displayValue }}
        />
      }
    />
  ) : null

  const renderInput = (openPickerOnClick: boolean) => (
    <Input
      id={id ?? reactId}
      aria-invalid={ariaInvalid}
      ref={inputRef}
      aria-label={ariaLabel}
      spellCheck="false"
      autoComplete="off"
      className={cn("h-7 w-full border border-input bg-transparent px-2 text-sm")}
      style={style}
      name={name}
      disabled={disabled}
      placeholder={inputPlaceholder ?? defaultValue}
      value={displayValue}
      onChange={(event) => changeText(event.target.value)}
      onPointerDown={() => {
        inputPointerStartedOpenRef.current = effectiveOpen
      }}
      onFocus={onTextFocus}
      onClick={() => {
        if (!openPickerOnClick) return

        setOpen(!inputPointerStartedOpenRef.current)
        inputPointerStartedOpenRef.current = false
      }}
      onBlur={onTextBlur}
    />
  )

  if (mode === "input") {
    return (
      <div className="flex w-full items-center">
        <Popover open={effectiveOpen} onOpenChange={setOpen}>
          <div className="relative w-full">
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={disabled}
                  aria-hidden="true"
                  tabIndex={-1}
                  className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
                />
              }
            />
            {renderInput(true)}
          </div>
          <PopoverContent ref={pickerRef} className="w-auto p-4" align="start">
            {picker}
          </PopoverContent>
        </Popover>
      </div>
    )
  }

  const input = hasInput ? renderInput(mode === "button-input") : null
  const controls =
    layout === "input-swatch" ? (
      <>
        {input}
        <Popover open={effectiveOpen} onOpenChange={setOpen}>
          {swatch}
          <PopoverContent ref={pickerRef} className="w-auto p-4" align="start">
            {picker}
          </PopoverContent>
        </Popover>
      </>
    ) : (
      <>
        <Popover open={effectiveOpen} onOpenChange={setOpen}>
          {swatch}
          <PopoverContent ref={pickerRef} className="w-auto p-4" align="start">
            {picker}
          </PopoverContent>
        </Popover>
        {input}
      </>
    )

  return <div className="flex w-full items-center gap-2">{controls}</div>
}

function formatPickerValue(value: unknown, formatted?: string): string {
  if (formatted) return formatted
  if (!Array.isArray(value)) return ""

  const [r, g, b, rawA] = value
  const safeR = Math.round(Number(r) || 0)
  const safeG = Math.round(Number(g) || 0)
  const safeB = Math.round(Number(b) || 0)
  const alpha = Number(rawA)
  const safeA = Number.isFinite(alpha) ? alpha : 1

  return `rgba(${safeR}, ${safeG}, ${safeB}, ${safeA})`
}
