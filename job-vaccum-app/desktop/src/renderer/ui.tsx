import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

// Capture the opening input before React mounts a menu, including context menus.
let keyboardInput = false;
document.addEventListener("keydown", () => { keyboardInput = true; }, true);
document.addEventListener("pointerdown", () => { keyboardInput = false; }, true);

/** Typing targets and open overlays keep their own keys; list shortcuts ignore them. */
export function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.matches("input, textarea, select") ||
    target.closest("dialog, .popover") !== null
  );
}

type Anchor = HTMLElement | { x: number; y: number };

/**
 * A floating panel next to its trigger. Outside clicks and Esc close it; Esc
 * returns focus to the trigger. No open/close animation: popovers here open
 * many times a day.
 */
export function Popover({
  anchor,
  onClose,
  placement = "bottom-start",
  className,
  label,
  role = "dialog",
  children,
  initialFocus = true,
  restoreFocus = true,
  onPointerEnter,
  onPointerLeave,
}: {
  anchor: Anchor;
  onClose: () => void;
  placement?: "bottom-start" | "bottom-end" | "right-start";
  className?: string;
  label: string;
  role?: "dialog" | "menu";
  children: ReactNode;
  initialFocus?: boolean;
  restoreFocus?: boolean;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const element = panel.current!;
    const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : new DOMRect(anchor.x, anchor.y, 0, 0);
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    let left = placement === "bottom-end" ? rect.right - width : placement === "right-start" ? rect.right + 6 : rect.left;
    let top = placement === "right-start" ? rect.top - 4 : rect.bottom + 4;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    if (top + height > window.innerHeight - 8) top = Math.max(8, (placement === "right-start" ? window.innerHeight : rect.top - 4) - height - (placement === "right-start" ? 8 : 0));
    setPosition({ left, top });
  }, [anchor, placement]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = panel.current!;
    if (initialFocus) {
      const target = panel.current?.querySelector<HTMLElement>("[data-autofocus]") ??
        panel.current?.querySelector<HTMLElement>("input, textarea, select, button:not(:disabled), [role^='menuitem']:not([aria-disabled='true'])");
      target?.focus();
    }
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target)) return;
      if (anchor instanceof HTMLElement && anchor.contains(target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      // Focus left inside the closing panel falls back to <body>; give it back to the trigger.
      const active = document.activeElement;
      if (restoreFocus && (!active || active === document.body || element.contains(active))) {
        (anchor instanceof HTMLElement ? anchor : opener)?.focus();
      }
    };
    // Opening is a mount; the panel does not re-run focus logic on re-render.
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      if (anchor instanceof HTMLElement) anchor.focus();
      onClose();
    }
  };

  // Until positioned it is transparent, not visibility:hidden, so the first focus() still lands.
  return createPortal(
    <div
      ref={panel}
      className={className ? `popover ${className}` : "popover"}
      role={role}
      aria-label={label}
      style={position ? { left: position.left, top: position.top } : { opacity: 0, left: 0, top: 0 }}
      onKeyDown={onKeyDown}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItem {
  key: string;
  label: ReactNode;
  /** Checked items show a check mark (radio or checkbox menus). */
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  hint?: ReactNode;
  onSelect: () => void;
}
export type MenuEntry = MenuItem | { heading: string } | "separator";

/** Keyboard-navigable menu (↑↓, Home/End, Return/Space) built on Popover. */
export function Menu({
  anchor,
  onClose,
  label,
  entries,
  placement,
  className,
  initialFocus,
  onPointerEnter,
  onPointerLeave,
}: {
  anchor: Anchor;
  onClose: () => void;
  label: string;
  entries: MenuEntry[];
  placement?: "bottom-start" | "bottom-end" | "right-start";
  className?: string;
  initialFocus?: boolean;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const focusFirst = useRef(initialFocus !== false && keyboardInput).current;
  useEffect(() => {
    // Mouse opening focuses the menu container, leaving every item unselected.
    if (initialFocus !== false && (!focusFirst || !list.current?.querySelector("[role^='menuitem']:not([aria-disabled='true'])"))) list.current?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>("[role^='menuitem']:not([aria-disabled='true'])") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => {
      event.preventDefault();
      items[(next + items.length) % items.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index < 0 ? items.length - 1 : index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(items.length - 1);
    else if (event.key === "Tab") event.preventDefault();
  };
  const hasChecks = entries.some((entry) => typeof entry === "object" && "key" in entry && entry.checked !== undefined);
  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      label={label}
      role="menu"
      placement={placement}
      className={className ? `menu ${className}` : "menu"}
      initialFocus={focusFirst}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div ref={list} tabIndex={-1} onKeyDown={onKeyDown} style={{ outline: "none" }}>
        {entries.map((entry, index) =>
          entry === "separator" ? (
            <div key={`separator-${index}`} className="menu-separator" role="separator" />
          ) : "heading" in entry ? (
            <div key={`heading-${entry.heading}`} className="menu-heading" role="presentation">
              {entry.heading}
            </div>
          ) : (
            <div
              key={entry.key}
              role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={entry.checked}
              aria-disabled={entry.disabled || undefined}
              tabIndex={-1}
              className={entry.danger ? "menu-item menu-item-danger" : "menu-item"}
              onClick={() => {
                if (entry.disabled) return;
                onClose();
                entry.onSelect();
              }}
              onKeyDown={(event) => {
                if ((event.key === "Enter" || event.key === " ") && !entry.disabled) {
                  event.preventDefault();
                  onClose();
                  entry.onSelect();
                }
              }}
              onPointerMove={(event) => {
                if (!entry.disabled) (event.currentTarget as HTMLElement).focus();
              }}
            >
              {hasChecks ? <span className="menu-check" aria-hidden="true">{entry.checked ? "✓" : ""}</span> : null}
              <span className="menu-label">{entry.label}</span>
              {entry.hint ? <span className="menu-hint">{entry.hint}</span> : null}
            </div>
          ),
        )}
      </div>
    </Popover>
  );
}

/**
 * Modal confirmation and form dialogs on the native <dialog> element: focus
 * stays inside, Esc cancels, and the initial focus goes to `initialFocus`
 * (Cancel for destructive confirmations).
 */
export function Dialog({
  title,
  onCancel,
  children,
  footer,
  initialFocus,
  className,
}: {
  title: string;
  onCancel: () => void;
  children: ReactNode;
  footer: ReactNode;
  initialFocus: RefObject<HTMLElement | null>;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useRef(`dialog-${Math.random().toString(36).slice(2)}`).current;
  useEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement as HTMLElement | null;
    element.showModal();
    initialFocus.current?.focus();
    return () => {
      element.close();
      opener?.focus();
    };
    // The dialog opens once per mount.
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className={className ? `dialog ${className}` : "dialog"}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id={titleId} className="dialog-title">
        {title}
      </h2>
      <div className="dialog-body">{children}</div>
      <div className="dialog-footer">{footer}</div>
    </dialog>,
    document.body,
  );
}
