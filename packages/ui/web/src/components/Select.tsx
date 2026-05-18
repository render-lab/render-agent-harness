import type { JSX, KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/**
 * Custom dropdown that replaces every native `<select>` in the operator
 * UI. The harness ships a brutalist black/white theme — native selects
 * look out of place because their popover is rendered by the browser
 * (rounded corners, light background, system font on macOS) and we
 * have no control over its style.
 *
 * The rendered DOM is a button-as-combobox plus a div listbox. Keyboard
 * support follows the WAI-ARIA combobox/listbox pattern as far as that
 * makes sense for a single-select with no free-text input:
 *
 *   - Space / Enter / ArrowDown on the closed combobox opens it.
 *   - ArrowUp / ArrowDown / Home / End move the active option.
 *   - Enter / Space on an option commits + closes.
 *   - Escape / Tab / outside click closes without committing.
 *
 * Disabled options are skipped during keyboard navigation but still
 * render so the labels stay visible to the operator.
 */
export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Optional secondary text shown right-aligned in the menu. */
  hint?: ReactNode;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (next: T) => void;
  ariaLabel?: string;
  /** Optional label rendered as the trigger when no value is set. */
  placeholder?: string;
  /** Tailwind classes applied to the button trigger. */
  className?: string;
  /** Tailwind classes applied to the popover. */
  menuClassName?: string;
  disabled?: boolean;
  id?: string;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = "select…",
  className = "",
  menuClassName = "",
  disabled = false,
  id,
}: SelectProps<T>): JSX.Element {
  const reactId = useId();
  const buttonId = id ?? `rh-select-${reactId}`;
  const listboxId = `${buttonId}-listbox`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value),
    ),
  );

  const selected = options.find((o) => o.value === value) ?? null;

  // Keep the active option in sync with `value` whenever the menu is
  // closed; opening should land focus on the current selection rather
  // than wherever the keyboard last hovered.
  useEffect(() => {
    if (!open) {
      const idx = options.findIndex((o) => o.value === value);
      setActiveIndex(idx >= 0 ? idx : 0);
    }
  }, [open, options, value]);

  const close = useCallback((focusButton: boolean) => {
    setOpen(false);
    if (focusButton) buttonRef.current?.focus();
  }, []);

  const commit = useCallback(
    (idx: number) => {
      const next = options[idx];
      if (!next || next.disabled) return;
      onChange(next.value);
      close(true);
    },
    [close, onChange, options],
  );

  const moveActive = useCallback(
    (delta: 1 | -1 | "home" | "end") => {
      if (options.length === 0) return;
      let next = activeIndex;
      const step = (cursor: number) => (cursor + options.length) % options.length;
      if (delta === "home") next = 0;
      else if (delta === "end") next = options.length - 1;
      else next = step(activeIndex + delta);
      // Skip disabled options in the same direction; bail if every
      // option is disabled to avoid an infinite loop.
      let guard = options.length;
      while (options[next]?.disabled && guard-- > 0) {
        if (delta === "home") next = step(next + 1);
        else if (delta === "end") next = step(next - 1);
        else next = step(next + delta);
      }
      setActiveIndex(next);
    },
    [activeIndex, options],
  );

  // Click-outside handler: a single document-level pointerdown listener
  // is cheaper than per-option blur tracking and copes with iframes /
  // shadow roots (the SPA renders inside an iframe in some embeds).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (buttonRef.current?.contains(target)) return;
      if (listRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Scroll the active option into view when navigating via keyboard.
  // Plain `scrollIntoView` jumps the page on iOS Safari; clamp it to
  // the listbox container.
  useLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    if (!item) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [activeIndex, open]);

  /**
   * The button stays focused at all times; the listbox is decorative.
   * That mirrors the ARIA combobox pattern (`aria-activedescendant`
   * carries the active option) and keeps focus management dead
   * simple — there's no list-keydown to wire up.
   */
  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
        moveActive(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveActive("home");
    } else if (event.key === "End") {
      event.preventDefault();
      moveActive("end");
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(activeIndex);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      // Let focus move naturally; just close the menu.
      close(false);
    }
  };

  return (
    <div className="relative inline-block w-full">
      <button
        ref={buttonRef}
        type="button"
        id={buttonId}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        aria-activedescendant={
          open && options[activeIndex] ? `${listboxId}-${activeIndex}` : undefined
        }
        disabled={disabled}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={onButtonKeyDown}
        className={`flex w-full items-center justify-between gap-2 border border-line bg-surface px-2.5 py-1.5 text-left text-xs ${
          disabled ? "opacity-50" : "hover:border-accent"
        } ${className}`}
      >
        <span className="truncate">
          {selected ? selected.label : <span className="text-muted">{placeholder}</span>}
        </span>
        <Chevron open={open} />
      </button>
      {open ? (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-labelledby={buttonId}
          className={`panel absolute left-0 right-0 z-50 mt-1 max-h-72 overflow-auto py-1 text-xs shadow-lg ${menuClassName}`}
        >
          {options.length === 0 ? (
            <div className="px-2 py-1.5 text-muted">no options</div>
          ) : (
            options.map((option, idx) => {
              const isActive = idx === activeIndex;
              const isSelected = option.value === value;
              // Options follow the WAI-ARIA combobox pattern: focus
              // stays on the trigger button and `aria-activedescendant`
              // points at the active option, so the options themselves
              // are intentionally non-focusable. Biome's a11y lints
              // can't see that, so we silence them here.
              return (
                // biome-ignore lint/a11y/useFocusableInteractive: aria-activedescendant pattern keeps focus on the combobox button
                // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handling lives on the combobox button
                <div
                  key={option.value}
                  id={`${listboxId}-${idx}`}
                  data-index={idx}
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={option.disabled || undefined}
                  onMouseEnter={() => !option.disabled && setActiveIndex(idx)}
                  onClick={() => commit(idx)}
                  className={`flex cursor-pointer items-center justify-between gap-3 px-2.5 py-1.5 ${
                    option.disabled
                      ? "cursor-not-allowed opacity-40"
                      : isActive
                        ? "bg-accent text-canvas"
                        : "text-ink"
                  }`}
                >
                  <span className="flex items-center gap-2 truncate">
                    <span
                      aria-hidden="true"
                      className={`inline-block w-2 ${isSelected ? "" : "opacity-0"}`}
                    >
                      ›
                    </span>
                    <span className="truncate">{option.label}</span>
                  </span>
                  {option.hint ? (
                    <span
                      className={`shrink-0 text-[10px] uppercase tracking-wider ${
                        isActive && !option.disabled ? "text-canvas" : "text-muted"
                      }`}
                    >
                      {option.hint}
                    </span>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      width="10"
      height="6"
      viewBox="0 0 10 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
      className={`shrink-0 transition-transform duration-100 ${open ? "rotate-180" : ""}`}
    >
      <path d="M1 1L5 5L9 1" />
    </svg>
  );
}
