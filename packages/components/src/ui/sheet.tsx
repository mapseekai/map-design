"use client"

import * as React from "react"
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"
import { cn } from "../lib/utils"

import { Button } from "./button"
import { XIcon } from "lucide-react"

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

const SheetTrigger = React.forwardRef<HTMLButtonElement, React.PropsWithoutRef<SheetPrimitive.Trigger.Props>>(function SheetTrigger({ ...props }, ref) {
  return <SheetPrimitive.Trigger ref={ref} data-slot="sheet-trigger" {...props} />
});

const SheetClose = React.forwardRef<React.ElementRef<typeof SheetPrimitive.Close>, React.PropsWithoutRef<SheetPrimitive.Close.Props>>(function SheetClose({ ...props }, ref) {
  return <SheetPrimitive.Close ref={ref} data-slot="sheet-close" {...props} />
});

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

const SheetOverlay = React.forwardRef<React.ElementRef<typeof SheetPrimitive.Backdrop>, React.PropsWithoutRef<SheetPrimitive.Backdrop.Props>>(function SheetOverlay({ className, ...props }, ref) {
  return (
    <SheetPrimitive.Backdrop ref={ref}
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs",
        className
      )}
      {...props}
    />
  )
});

const SheetContent = React.forwardRef<React.ElementRef<typeof SheetPrimitive.Popup>, React.PropsWithoutRef<SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
  keepMountedPopup?: boolean
  variant?: "default" | "panel"
}>>(function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  keepMountedPopup = false,
  variant = "default",
  ...props
}, ref) {
  return (
    <SheetPortal keepMounted={keepMountedPopup}>
      <SheetOverlay />
      <SheetPrimitive.Popup ref={ref}
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "fixed z-50 flex flex-col gap-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg transition duration-200 ease-in-out data-ending-style:opacity-0 data-starting-style:opacity-0 data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=bottom]:data-ending-style:translate-y-[2.5rem] data-[side=bottom]:data-starting-style:translate-y-[2.5rem] data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=left]:data-ending-style:translate-x-[-2.5rem] data-[side=left]:data-starting-style:translate-x-[-2.5rem] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:data-ending-style:translate-x-[2.5rem] data-[side=right]:data-starting-style:translate-x-[2.5rem] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=top]:data-ending-style:translate-y-[-2.5rem] data-[side=top]:data-starting-style:translate-y-[-2.5rem] data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm",
          variant === "panel" && "gap-0 data-[side=bottom]:rounded-t-2xl data-[closing=true]:pointer-events-none data-[closing=true]:opacity-0 data-[side=right]:data-[closing=true]:translate-x-full data-[side=left]:data-[closing=true]:-translate-x-full data-[side=bottom]:data-[closing=true]:translate-y-full data-[closing=true]:duration-[140ms] motion-reduce:transition-none",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-3 right-3"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  )
});

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-0.5 p-4", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

const SheetTitle = React.forwardRef<React.ElementRef<typeof SheetPrimitive.Title>, React.PropsWithoutRef<SheetPrimitive.Title.Props>>(function SheetTitle({ className, ...props }, ref) {
  return (
    <SheetPrimitive.Title ref={ref}
      data-slot="sheet-title"
      className={cn(
        "text-base font-medium text-foreground",
        className
      )}
      {...props}
    />
  )
});

const SheetDescription = React.forwardRef<React.ElementRef<typeof SheetPrimitive.Description>, React.PropsWithoutRef<SheetPrimitive.Description.Props>>(function SheetDescription({
  className,
  ...props
}, ref) {
  return (
    <SheetPrimitive.Description ref={ref}
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
});

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
