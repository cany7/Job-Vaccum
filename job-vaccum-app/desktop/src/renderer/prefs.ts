import { useCallback, useEffect, useState } from "react";
import { readListPrefs, type ListPage, type ListPrefs } from "./listModel";

// Local UI preferences live only in this Mac's renderer storage (CONTRACTS):
// no service command, no SQLite.
export type Mode = "system" | "light" | "dark";
export type Theme = "graphite" | "pine" | "ink";
export interface UiPrefs {
  mode: Mode;
  lightTheme: Theme;
  darkTheme: Theme;
  sidebarCollapsed: boolean;
  /** Each list page remembers its own filters, sort, rows per page and columns. */
  lists: Record<ListPage, ListPrefs>;
}

export const themes: Theme[] = ["graphite", "pine", "ink"];
const modes: Mode[] = ["system", "light", "dark"];
const KEY = "jobVaccum.ui";
const defaults = { mode: "system", lightTheme: "graphite", darkTheme: "graphite" } as const;

export function readPrefs(): UiPrefs {
  let stored: Partial<Record<keyof UiPrefs, unknown>> = {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (parsed && typeof parsed === "object") stored = parsed;
  } catch {
    // Unreadable preferences fall back to defaults.
  }
  if (!stored.lists || typeof stored.lists !== "object") stored.lists = undefined;
  const pick = <T>(value: unknown, allowed: readonly T[], fallback: T) =>
    allowed.includes(value as T) ? (value as T) : fallback;
  return {
    mode: pick(stored.mode, modes, defaults.mode),
    lightTheme: pick(stored.lightTheme, themes, defaults.lightTheme),
    darkTheme: pick(stored.darkTheme, themes, defaults.darkTheme),
    sidebarCollapsed: stored.sidebarCollapsed === true,
    lists: {
      jobs: readListPrefs("jobs", (stored.lists as Record<string, unknown> | undefined)?.jobs),
      shortlist: readListPrefs("shortlist", (stored.lists as Record<string, unknown> | undefined)?.shortlist),
    },
  };
}

const darkQuery = () => matchMedia("(prefers-color-scheme: dark)");

/** Sets the resolved scheme and theme on <html>; CSS variables do the rest. */
export function applyAppearance(prefs: UiPrefs) {
  const scheme = prefs.mode === "system" ? (darkQuery().matches ? "dark" : "light") : prefs.mode;
  const root = document.documentElement;
  root.dataset.scheme = scheme;
  root.dataset.theme = scheme === "dark" ? prefs.darkTheme : prefs.lightTheme;
}

export function usePrefs() {
  const [prefs, setPrefs] = useState(readPrefs);
  const update = useCallback((change: Partial<UiPrefs> | ((previous: UiPrefs) => Partial<UiPrefs>)) => {
    setPrefs((previous) => {
      const next = { ...previous, ...(typeof change === "function" ? change(previous) : change) };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Storage failure only loses the preference for the next launch.
      }
      return next;
    });
  }, []);
  useEffect(() => {
    applyAppearance(prefs);
    if (prefs.mode !== "system") return;
    const query = darkQuery();
    const follow = () => applyAppearance(prefs);
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [prefs]);
  return [prefs, update] as const;
}

/** True while the window is narrower than the sidebar auto-collapse width. */
export function useNarrow() {
  const query = "(max-width: 1099px)";
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query);
    const change = () => setNarrow(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, []);
  return narrow;
}

export type UpdatePrefs = ReturnType<typeof usePrefs>[1];

/** Merges a change into one list page's remembered settings. */
export function updateList(updatePrefs: UpdatePrefs, page: ListPage, change: Partial<ListPrefs>) {
  updatePrefs((previous) => ({ lists: { ...previous.lists, [page]: { ...previous.lists[page], ...change } } }));
}
