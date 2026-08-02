import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "./backend-error";
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  type Settings,
} from "./settings";

/**
 * The app's settings (issue #9): loaded once at startup, written back as soon
 * as one is changed.
 *
 * Every setting here is a toggle or a pick, so there is nothing to debounce —
 * and unlike the note, nothing to merge either. A save that fails puts the
 * screen back to what is actually on disk rather than leaving a value the
 * reader would believe had been kept.
 */

export interface UseSettingsResult {
  /** The defaults until the load finishes; the screen never has to wait. */
  settings: Settings;
  loaded: boolean;
  /** Last load or save failure, for the settings screen to surface. */
  error: string | null;
  /** Applies a change and writes it; ignored until the initial load is done. */
  update(change: (current: Settings) => Settings): void;
}

export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** What is on screen, for `update` to build the next value from. */
  const currentRef = useRef<Settings>(settings);
  /** What the backend last confirmed, to fall back to when a save fails. */
  const persistedRef = useRef<Settings>(settings);
  /** Serializes saves so two writes never interleave. */
  const flushRef = useRef<Promise<void>>(Promise.resolve());
  const loadedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void loadSettings()
      .then((stored) => {
        currentRef.current = stored;
        persistedRef.current = stored;
        loadedRef.current = true;
        if (!mountedRef.current) return;
        setSettings(stored);
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        if (!mountedRef.current) return;
        // The defaults stay on screen, but nothing is written over a file we
        // failed to read: `loadedRef` stays false, so `update` is refused.
        setError(describeError(cause));
      });
  }, []);

  const update = useCallback((change: (current: Settings) => Settings) => {
    if (!loadedRef.current) return;
    const next = change(currentRef.current);
    currentRef.current = next;
    setSettings(next);
    setError(null);

    flushRef.current = flushRef.current.then(async () => {
      try {
        const stored = await saveSettings(next);
        persistedRef.current = stored;
        // Only if nothing has been changed since: an earlier save finishing
        // late must not put its value back on screen.
        if (currentRef.current !== next) return;
        currentRef.current = stored;
        if (mountedRef.current) setSettings(stored);
      } catch (cause) {
        if (!mountedRef.current) return;
        setError(describeError(cause));
        if (currentRef.current !== next) return;
        currentRef.current = persistedRef.current;
        setSettings(persistedRef.current);
      }
    });
  }, []);

  return { settings, loaded, error, update };
}
