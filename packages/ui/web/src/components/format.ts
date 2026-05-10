/**
 * Display formatters used across the SPA.
 *
 * Built on standard libraries — don't reinvent here:
 *   - `date-fns` for ISO → human time strings
 *   - `pretty-ms` for durations
 *   - `Intl.NumberFormat` for tokens and USD
 */

import { format as formatDate, formatDistanceToNowStrict, parseISO } from "date-fns";
import prettyMs from "pretty-ms";

const tokenFmt = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const usdSmallFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

export function formatRelative(iso: string): string {
  const d = parseISO(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${formatDistanceToNowStrict(d, { addSuffix: true })}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = parseISO(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatDate(d, "yyyy-MM-dd HH:mm:ss");
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return prettyMs(ms, { compact: true });
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return tokenFmt.format(n);
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return usdFmt.format(0);
  return n > 0 && n < 0.01 ? usdSmallFmt.format(n) : usdFmt.format(n);
}
