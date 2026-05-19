import type { JSX, KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { LuCheck, LuChevronDown } from "react-icons/lu";

/**
 * Custom dropdown that replaces every native `<select>` on the wizard's
 * Browse page. Native option lists are rendered by the OS — they bring
 * back rounded corners, system fonts, and a scrollbar that doesn't
 * match anything else on the page. The button-as-combobox + listbox
 * shape below sticks to the brutalist theme tokens (`bg-surface`,
 * `border-line`, `text-accent`).
 *
 * Keyboard support follows the WAI-ARIA combobox/listbox pattern for a
 * single-select with no free-text input:
 *
 *   - Space / Enter / ArrowDown / ArrowUp on the closed combobox opens
 *     it.
 *   - ArrowUp / ArrowDown / Home / End move the active option.
 *   - Enter / Space on an option commits + closes.
 *   - Escape / Tab / outside click closes without committing.
 */
export interface SelectOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Optional leading glyph rendered to the left of the label. */
  icon?: ReactNode;
  /** Optional secondary text shown right-aligned in the menu. */
  hint?: ReactNode;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (next: T) => void;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
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
  const buttonId = id ?? `wiz-select-${reactId}`;
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
        } ${open ? "border-accent" : ""} ${className}`}
      >
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          {selected?.icon ? (
            <span aria-hidden className="shrink-0 text-muted">
              {selected.icon}
            </span>
          ) : null}
          <span className="truncate">
            {selected ? selected.label : <span className="text-muted">{placeholder}</span>}
          </span>
        </span>
        <LuChevronDown
          aria-hidden
          className={`shrink-0 text-muted transition-transform duration-100 ${open ? "rotate-180" : ""}`}
        />
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
                  <span className="flex min-w-0 items-center gap-2 truncate">
                    <span aria-hidden className="w-3 shrink-0">
                      {isSelected ? <LuCheck className="text-current" /> : null}
                    </span>
                    {option.icon ? (
                      <span
                        aria-hidden
                        className={`shrink-0 ${isActive ? "text-canvas" : "text-muted"}`}
                      >
                        {option.icon}
                      </span>
                    ) : null}
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
