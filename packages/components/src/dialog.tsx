import { useRef, type ComponentProps, type FormEventHandler, type ReactNode } from 'react';
import { Dialog as DialogRoot, DialogContent } from './ui/dialog';
import { cn } from './lib/utils';
export { DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';

export interface DialogProps {
  children: ReactNode;
  initialFocus?: ComponentProps<typeof DialogContent>["initialFocus"];
  finalFocus?: ComponentProps<typeof DialogContent>["finalFocus"];
  onClose?: () => void;
  className?: string;
  backdropClassName?: string;
  includeChromeClassName?: boolean;
  id?: string;
  role?: 'dialog' | 'alertdialog';
  ariaLabel?: string;
  ariaLabelledBy?: string;
  ariaDescribedBy?: string;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  layout?: 'default' | 'sectioned';
  as?: 'div' | 'form';
  onSubmit?: FormEventHandler<HTMLFormElement>;
  [key: `data-${string}`]: string | number | undefined;
}

/** Existing workflow API backed by shadcn's portalled, focus-managed dialog. */
export function Dialog({
  children, onClose, className, backdropClassName, includeChromeClassName: _chrome,
  id, role = 'dialog', ariaLabel, ariaLabelledBy, ariaDescribedBy,
  closeOnBackdrop = true, closeOnEscape = false, layout = 'default',
  as = 'div', onSubmit, initialFocus, finalFocus, ...dataAttributes
}: DialogProps) {
  const returnFocus = useRef(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return <DialogRoot open onOpenChange={(open, details) => {
    if (open) return;
    if ((!closeOnBackdrop && details.reason === 'outside-press') || (!closeOnEscape && details.reason === 'escape-key')) {
      details.cancel();
      return;
    }
    onClose?.();
  }}>
    <DialogContent
      {...dataAttributes}
      {...(id ? { id } : {})}
      role={role}
      aria-modal="true"
      initialFocus={initialFocus ?? true}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      aria-describedby={ariaDescribedBy}
      showCloseButton={false}
      overlayClassName={backdropClassName}
      layout={layout}
      className={cn('max-h-[calc(100dvh-2rem)] overflow-y-auto', className)}
      finalFocus={finalFocus ?? (() => {
        const target = returnFocus.current;
        return target?.isConnected && !target.closest('[inert], [hidden]') && !target.matches(':disabled') ? target : false;
      })}
    >
      {as === 'form' ? <form onSubmit={onSubmit} className="grid gap-4">{children}</form> : children}
    </DialogContent>
  </DialogRoot>;
}

export function DialogBody({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="dialog-body" className={cn('min-h-0 overflow-y-auto py-4', className)} {...props} />;
}
