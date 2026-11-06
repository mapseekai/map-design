import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { cn } from "../lib/utils"

import { Button } from "./button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

const DialogTrigger = React.forwardRef<HTMLButtonElement, React.PropsWithoutRef<DialogPrimitive.Trigger.Props>>(function DialogTrigger({ ...props }, ref) {
  return <DialogPrimitive.Trigger ref={ref} data-slot="dialog-trigger" {...props} />
});

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

const DialogClose = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Close>, React.PropsWithoutRef<DialogPrimitive.Close.Props>>(function DialogClose({ ...props }, ref) {
  return <DialogPrimitive.Close ref={ref} data-slot="dialog-close" {...props} />
});

const DialogOverlay = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Backdrop>, React.PropsWithoutRef<DialogPrimitive.Backdrop.Props>>(function DialogOverlay({
  className,
  ...props
}, ref) {
  return (
    <DialogPrimitive.Backdrop ref={ref}
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
});

const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Popup>, React.PropsWithoutRef<DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  closeLabel?: string
  overlayClassName?: string | undefined
  layout?: "default" | "sectioned"
}>>(function DialogContent({
  className,
  children,
  showCloseButton = true,
  closeLabel = "Close",
  overlayClassName,
  layout = "default",
  ...props
}, ref) {
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Popup ref={ref}
        data-slot="dialog-content"
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          layout === "sectioned" && "gap-0",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">{closeLabel}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
});

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

const DialogTitle = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Title>, React.PropsWithoutRef<DialogPrimitive.Title.Props>>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title ref={ref}
      data-slot="dialog-title"
      className={cn(
        "text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
});

const DialogDescription = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Description>, React.PropsWithoutRef<DialogPrimitive.Description.Props>>(function DialogDescription({
  className,
  ...props
}, ref) {
  return (
    <DialogPrimitive.Description ref={ref}
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
});

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
