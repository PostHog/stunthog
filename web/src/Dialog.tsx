import {
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Dialog as QuillDialog,
} from "@posthog/quill";
import type { ReactNode } from "react";

export function Dialog({
  title,
  children,
  description,
  footer,
  className,
  onClose,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  description?: string;
  footer?: ReactNode;
  className?: string;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <QuillDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        size="wide"
        className={className}
        showCloseButton={!busy}
        // Portal events still reach the eval form through the React tree.
        onSubmit={(event) => event.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogBody>
          <div className="dialog-body">{children}</div>
        </DialogBody>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </QuillDialog>
  );
}
