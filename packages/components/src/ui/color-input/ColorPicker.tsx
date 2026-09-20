// Adapted from https://mapseekai.github.io/mapseek-ui/r/color-input.json
"use client"

import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import { Pipette } from "lucide-react"
import Color from "color"
import {
  type ComponentProps,
  createContext,
  type HTMLAttributes,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Button } from "../button"
import { Input } from "../input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../select"
import { cn } from "../../lib/utils"

type ColorPickerContextValue = {
  hue: number
  saturation: number
  lightness: number
  alpha: number
  mode: string
  setHue: (hue: number) => void
  setSaturation: (saturation: number) => void
  setLightness: (lightness: number) => void
  setAlpha: (alpha: number) => void
  setMode: (mode: string) => void
}

function parseColor(value: Parameters<typeof Color>[0]) {
  try { return Color(value) } catch { return Color("#000000") }
}

const ColorPickerContext = createContext<ColorPickerContextValue | undefined>(undefined)
const RGB_OUTPUT_CHANNELS = ["red", "green", "blue"] as const
const HSL_OUTPUT_CHANNELS = ["hue", "saturation", "lightness"] as const

export const useColorPicker = () => {
  const context = useContext(ColorPickerContext)

  if (!context) {
    throw new Error("useColorPicker must be used within a ColorPickerProvider")
  }

  return context
}

export type ColorPickerProps = HTMLAttributes<HTMLDivElement> & {
  value?: Parameters<typeof Color>[0]
  defaultValue?: Parameters<typeof Color>[0]
  onChange?: (value: Parameters<typeof Color.rgb>[0], formatted?: string) => void
}

export const ColorPicker = ({
  value,
  defaultValue = "#000000",
  onChange,
  className,
  ...props
}: ColorPickerProps) => {
  const selectedColor = parseColor(value || defaultValue)
  const defaultColor = parseColor(defaultValue)

  const [hue, setHue] = useState(selectedColor.hue() || defaultColor.hue() || 0)
  const [saturation, setSaturation] = useState(
    selectedColor.saturationl(),
  )
  const [lightness, setLightness] = useState(
    selectedColor.lightness(),
  )
  const [alpha, setAlpha] = useState(selectedColor.alpha() * 100)
  const [mode, setMode] = useState("hex")
  const previousModeRef = useRef(mode)
  // The notify effect below fires on every state change. When the value
  // prop changes the sync effect schedules new HSL state, but the notify
  // effect runs on the SAME render with the *old* state — which produces a
  // stale formattedString, calls onChange, the parent stores it, value
  // prop changes again, sync effect re-runs ... forever (gray flips to
  // pink-ish red endlessly for any achromatic input). This ref records
  // "the last state change came from the value prop, not the user", so
  // notify can skip emitting until the user actually interacts.
  const isSyncingFromValueRef = useRef(false)

  // Update color when controlled value changes.
  // Color(rgba|hex) for any grayscale value returns NaN for .hue() because
  // hue is undefined when chroma is 0. Coerce undefined channels to 0 —
  // the same guard that the initial-state hooks above rely on.
  useEffect(() => {
    if (value) {
      const color = parseColor(value)
      const safe = (n: number) => (Number.isFinite(n) ? n : 0)
      isSyncingFromValueRef.current = true
      setHue(safe(color.hue()))
      setSaturation(safe(color.saturationl()))
      setLightness(safe(color.lightness()))
      setAlpha(safe(color.alpha()) * 100)
    }
  }, [value])

  // Latest props read by the notify effect. Storing them in refs keeps
  // the effect's dep array down to just the HSL/alpha/mode state — the
  // only inputs that represent a real user change. Including `onChange`
  // or `value` in deps re-fires the effect when the parent re-renders
  // (zustand store updates rebuild the InputColor → new onChange identity),
  // which consumed `isSyncingFromValueRef` early and produced the
  // "Maximum update depth exceeded" loop on alpha drag.
  const onChangeRef = useRef(onChange)
  const valueRef = useRef(value)
  useEffect(() => {
    onChangeRef.current = onChange
    valueRef.current = value
  })

  // Notify parent of changes
  useEffect(() => {
    if (isSyncingFromValueRef.current) {
      isSyncingFromValueRef.current = false
      return
    }
    const cb = onChangeRef.current
    if (!cb) return
    const color = Color.hsl(hue, saturation, lightness).alpha(alpha / 100)
    // .array() returns [r,g,b,a] when alpha<1 — slice to keep just RGB,
    // then we append alpha explicitly in the formatted strings below.
    const rgba = color.rgb().array().slice(0, 3)

    let formattedString = ""
    if (mode === "hex") {
      // color.hex() drops alpha. When the user has dialed alpha < 1 we
      // must emit a format that preserves it, otherwise the parent stores
      // an alpha-less hex, the value-sync effect resets state alpha to
      // 100, and the alpha drag silently snaps back.
      formattedString =
        alpha < 100 ? `rgba(${rgba.map(Math.round).join(", ")}, ${alpha / 100})` : color.hex()
    } else if (mode === "rgb") {
      formattedString = `rgba(${rgba.map(Math.round).join(", ")}, ${alpha / 100})`
    } else if (mode === "css") {
      formattedString = `rgba(${(rgba[0] ?? 0).toFixed(0)}, ${(rgba[1] ?? 0).toFixed(0)}, ${(rgba[2] ?? 0).toFixed(0)}, ${alpha / 100})`
    } else if (mode === "hsl") {
      const hsl = color.hsl().array()
      formattedString = `hsla(${(hsl[0] ?? 0).toFixed(0)}, ${(hsl[1] ?? 0).toFixed(0)}%, ${(hsl[2] ?? 0).toFixed(0)}%, ${alpha / 100})`
    } else {
      formattedString = `rgba(${rgba.map(Math.round).join(", ")}, ${alpha / 100})`
    }

    const currentValue = parseColor(valueRef.current || "#000000")
    const currentRgba = currentValue.rgb().array()
    const currentAlpha = currentValue.alpha()

    const rgbDiff = rgba.some((v, i) => Math.abs(v - (currentRgba[i] || 0)) > 1)
    const alphaDiff = Math.abs(alpha / 100 - currentAlpha) > 0.01
    const modeChanged = previousModeRef.current !== mode
    previousModeRef.current = mode

    if (rgbDiff || alphaDiff || modeChanged) {
      cb([rgba[0], rgba[1], rgba[2], alpha / 100], formattedString)
    }
  }, [hue, saturation, lightness, alpha, mode])

  const contextValue = useMemo(
    () => ({
      hue,
      saturation,
      lightness,
      alpha,
      mode,
      setHue,
      setSaturation,
      setLightness,
      setAlpha,
      setMode,
    }),
    [hue, saturation, lightness, alpha, mode],
  )

  return (
    <ColorPickerContext.Provider value={contextValue}>
      <div className={cn("flex size-full flex-col gap-4", className)} {...props} />
    </ColorPickerContext.Provider>
  )
}

export type ColorPickerSelectionProps = HTMLAttributes<HTMLDivElement>

export const ColorPickerSelection = memo(({ className, ...props }: ColorPickerSelectionProps) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const { hue, saturation, lightness, setSaturation, setLightness } = useColorPicker()
  const positionX = Math.max(0, Math.min(1, saturation / 100))
  const topLightness = positionX < 0.01 ? 100 : 100 - 50 * positionX
  const positionY = Math.max(0, Math.min(1, 1 - lightness / topLightness))

  const backgroundGradient = useMemo(() => {
    return `linear-gradient(0deg, rgba(0,0,0,1), rgba(0,0,0,0)),
            linear-gradient(90deg, rgba(255,255,255,1), rgba(255,255,255,0)),
            hsl(${hue}, 100%, 50%)`
  }, [hue])

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      if (!isDragging) return
      if (!containerRef.current) return

      const rect = containerRef.current.getBoundingClientRect()
      const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
      const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
      setSaturation(x * 100)
      const topLightness = x < 0.01 ? 100 : 50 + 50 * (1 - x)
      const lightness = topLightness * (1 - y)

      setLightness(lightness)
    },
    [isDragging, setSaturation, setLightness],
  )

  useEffect(() => {
    const handlePointerUp = (e: PointerEvent) => {
      setIsDragging(false)
      if (containerRef.current) {
        try {
          containerRef.current.releasePointerCapture(e.pointerId)
        } catch (_err) {
          // ignore
        }
      }
    }

    if (isDragging) {
      // Force crosshair cursor on body during drag to prevent flickering
      const originalCursor = document.body.style.cursor
      document.body.style.cursor = "crosshair"

      window.addEventListener("pointermove", handlePointerMove)
      window.addEventListener("pointerup", handlePointerUp)

      return () => {
        document.body.style.cursor = originalCursor
        window.removeEventListener("pointermove", handlePointerMove)
        window.removeEventListener("pointerup", handlePointerUp)
      }
    }
  }, [isDragging, handlePointerMove])

  return (
    <div
      className={cn("relative size-full cursor-crosshair touch-none select-none", className)}
      onPointerDown={(e) => {
        e.preventDefault()
        setIsDragging(true)
        e.currentTarget.setPointerCapture(e.pointerId)
        handlePointerMove(e.nativeEvent)
      }}
      ref={containerRef}
      style={{
        background: backgroundGradient,
      }}
      {...props}
    >
      <div
        className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary outline-2 -outline-offset-3 outline-white"
        style={{
          left: `${positionX * 100}%`,
          top: `${positionY * 100}%`,
        }}
      />
    </div>
  )
})

ColorPickerSelection.displayName = "ColorPickerSelection"

export type ColorPickerHueProps = ComponentProps<typeof SliderPrimitive.Root>

export const ColorPickerHue = ({ className, "aria-label": ariaLabel, ...props }: ColorPickerHueProps) => {
  const { hue, setHue } = useColorPicker()

  return (
    <SliderPrimitive.Root
      className={cn("relative flex h-4 w-full touch-none", className)}
      max={360}
      onValueChange={(value) => {
        const next = Array.isArray(value) ? value[0] : value
        if (typeof next === "number") setHue(next)
      }}
      step={1}
      value={[hue]}
      {...props}
    >
      <SliderPrimitive.Control className="relative flex h-full w-full touch-none items-center">
        <SliderPrimitive.Track className="relative my-0.5 h-3 w-full grow bg-[linear-gradient(90deg,#FF0000,#FFFF00,#00FF00,#00FFFF,#0000FF,#FF00FF,#FF0000)]">
          <SliderPrimitive.Indicator className="absolute h-full" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-label={ariaLabel}
          index={0}
          className="block size-4 rounded-full border border-primary/50 bg-background transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/20 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export type ColorPickerAlphaProps = ComponentProps<typeof SliderPrimitive.Root>

export const ColorPickerAlpha = ({ className, "aria-label": ariaLabel, ...props }: ColorPickerAlphaProps) => {
  const { alpha, setAlpha } = useColorPicker()

  return (
    <SliderPrimitive.Root
      max={100}
      onValueChange={(value) => {
        const next = Array.isArray(value) ? value[0] : value
        if (typeof next === "number") setAlpha(next)
      }}
      step={1}
      value={[alpha]}
      {...props}
    >
      <SliderPrimitive.Control
        className={cn("relative flex h-4 w-full touch-none items-center", className)}
      >
        <SliderPrimitive.Track className="relative my-0.5 h-3 w-full grow bg-[url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVQ4T2NkYGAQYcAP3uCTZhw1gGGYhAGBZIA/nYDCgBDAm9BGDWAAJyRCgLaBCAAgXwixzAS0pgAAAABJRU5ErkJggg==')] bg-center bg-repeat-x dark:bg-[url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALklEQVR4nGP8+vWrCAMewM3N/QafPBM+SWLAqAGDwQBGQgoIpZOB98KoAVQwAADxzQcSVIRCfQAAAABJRU5ErkJggg==')]">
          <div className="absolute inset-0 bg-linear-to-r from-transparent to-black/50 dark:to-white/50" />
          <SliderPrimitive.Indicator className="absolute h-full bg-transparent" />
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-label={ariaLabel}
          index={0}
          className="block size-4 rounded-full border border-primary/50 bg-background transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/20 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export type ColorPickerEyeDropperProps = ComponentProps<typeof Button>

type EyeDropperConstructor = new () => {
  open: () => Promise<{ sRGBHex: string }>
}

export const ColorPickerEyeDropper = ({
  className,
  onClick,
  ...props
}: ColorPickerEyeDropperProps) => {
  const inputRef = useRef<HTMLInputElement>(null)
  const { hue, saturation, lightness, setHue, setSaturation, setLightness, setAlpha } =
    useColorPicker()

  const applyColor = useCallback(
    (value: string) => {
      const color = parseColor(value)
      const [h, s, l] = color.hsl().array()

      setHue(Number.isFinite(h) ? h! : 0)
      setSaturation(Number.isFinite(s) ? s! : 0)
      setLightness(Number.isFinite(l) ? l! : 0)
      setAlpha(100)
    },
    [setHue, setSaturation, setLightness, setAlpha],
  )

  const handleEyeDropper: ColorPickerEyeDropperProps["onClick"] = async (event) => {
    onClick?.(event)
    if (event.defaultPrevented) return

    const EyeDropper = (
      globalThis as typeof globalThis & {
        EyeDropper?: EyeDropperConstructor
      }
    ).EyeDropper

    if (!EyeDropper) {
      inputRef.current?.click()
      return
    }

    try {
      const eyeDropper = new EyeDropper()
      const result = await eyeDropper.open()
      applyColor(result.sRGBHex)
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "AbortError"
      ) {
        return
      }
      console.error("EyeDropper failed:", error)
    }
  }

  const fallbackColor = Color.hsl(hue, saturation, lightness).hex()

  return (
    <>
      <Button
        aria-label="Pick color"
        className={cn("shrink-0 text-muted-foreground", className)}
        onClick={handleEyeDropper}
        size="icon"
        type="button"
        variant="outline"
        {...props}
      >
        <Pipette size={16} strokeWidth={1.5} />
      </Button>
      <input
        ref={inputRef}
        aria-hidden="true"
        className="sr-only"
        tabIndex={-1}
        type="color"
        value={fallbackColor}
        onChange={(event) => applyColor(event.target.value)}
      />
    </>
  )
}

export type ColorPickerOutputProps = {
  className?: string
}

const formats = ["hex", "rgb", "css", "hsl"]

export const ColorPickerOutput = ({ className }: ColorPickerOutputProps) => {
  const { mode, setMode } = useColorPicker()

  return (
    <Select onValueChange={(value) => value != null && setMode(value)} value={mode}>
      <SelectTrigger aria-label="RGB / HSL / HEX" className={cn("w-20 shrink-0", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {formats.map((format) => (
            <SelectItem className="text-sm" key={format} value={format}>
              {format.toUpperCase()}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

type PercentageInputProps = ComponentProps<typeof Input>

const PercentageInput = ({ className, ...props }: PercentageInputProps) => {
  return (
    <div className="relative w-16 shrink-0">
      <Input
        readOnly
        type="text"
        {...props}
        className={cn(
          "h-8 w-full rounded-l-none bg-secondary pl-2 pr-5 text-sm shadow-none",
          className,
        )}
      />
      <span className="absolute top-1/2 right-2 -translate-y-1/2 text-sm text-muted-foreground">
        %
      </span>
    </div>
  )
}

export type ColorPickerFormatProps = HTMLAttributes<HTMLDivElement>

export const ColorPickerFormat = ({ className, ...props }: ColorPickerFormatProps) => {
  const { hue, saturation, lightness, alpha, mode } = useColorPicker()
  const color = Color.hsl(hue, saturation, lightness, alpha / 100)

  if (mode === "hex") {
    const hex = color.hex()

    return (
      <div className={cn("relative flex w-full items-center -space-x-px", className)} {...props}>
        <Input
          className="h-8 rounded-r-none bg-secondary px-2 text-sm shadow-none"
          readOnly
          type="text"
          value={hex}
        />
        <PercentageInput value={Math.round(alpha)} />
      </div>
    )
  }

  if (mode === "rgb") {
    const rgb = color
      .rgb()
      .array()
      .map((value) => Math.round(value))

    return (
      <div className={cn("flex items-center -space-x-px", className)} {...props}>
        {RGB_OUTPUT_CHANNELS.map((channel, index) => (
          <Input
            className={cn(
              "h-8 rounded-r-none bg-secondary px-2 text-sm shadow-none",
              index && "rounded-l-none",
              className,
            )}
            key={channel}
            readOnly
            type="text"
            value={rgb[index]}
          />
        ))}
        <PercentageInput value={Math.round(alpha)} />
      </div>
    )
  }

  if (mode === "css") {
    const rgb = color
      .rgb()
      .array()
      .map((value) => Math.round(value))

    return (
      <div className={cn("w-full", className)} {...props}>
        <Input
          className="h-8 w-full bg-secondary px-2 text-sm shadow-none"
          readOnly
          type="text"
          value={`rgba(${rgb.join(", ")}, ${alpha}%)`}
          {...props}
        />
      </div>
    )
  }

  if (mode === "hsl") {
    const hsl = color
      .hsl()
      .array()
      .map((value) => Math.round(value))

    return (
      <div className={cn("flex items-center -space-x-px", className)} {...props}>
        {HSL_OUTPUT_CHANNELS.map((channel, index) => (
          <Input
            className={cn(
              "h-8 rounded-r-none bg-secondary px-2 text-sm shadow-none",
              index && "rounded-l-none",
              className,
            )}
            key={channel}
            readOnly
            type="text"
            value={hsl[index]}
          />
        ))}
        <PercentageInput value={Math.round(alpha)} />
      </div>
    )
  }

  return null
}
