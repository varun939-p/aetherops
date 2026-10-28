"use client";

import { useCallback, useSyncExternalStore } from "react";

/** Per-viewer UI preferences persisted in localStorage (theme, code zoom). Safe when storage is unavailable. */

type Listener = () => void;
const listeners = new Set<Listener>();

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the preference lasts for this page view only
  }
  memory.set(key, value);
  listeners.forEach((l) => l());
}

const memory = new Map<string, string>();
const subscribe = (l: Listener) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function usePreference(key: string, fallback: string): [string, (v: string) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => memory.get(key) ?? read(key) ?? fallback,
    () => fallback
  );
  const set = useCallback((v: string) => write(key, v), [key]);
  return [value, set];
}

export type Theme = "light" | "dark";

export function useTheme(): [Theme, (t: Theme) => void] {
  const [value, set] = usePreference("aetherops.theme", "light");
  const setTheme = useCallback(
    (t: Theme) => {
      if (t === "dark") document.documentElement.dataset.theme = "dark";
      else delete document.documentElement.dataset.theme;
      set(t);
    },
    [set]
  );
  return [value === "dark" ? "dark" : "light", setTheme];
}

export const CODE_ZOOM_STEPS = [11, 12, 13, 14, 15, 16, 18, 20, 22] as const;
export const DEFAULT_CODE_SIZE = 14;

export function useCodeFontSize(): [number, (n: number) => void] {
  const [value, set] = usePreference("aetherops.codeSize", String(DEFAULT_CODE_SIZE));
  const n = Number(value);
  const size = (CODE_ZOOM_STEPS as readonly number[]).includes(n) ? n : DEFAULT_CODE_SIZE;
  return [size, useCallback((v: number) => set(String(v)), [set])];
}
