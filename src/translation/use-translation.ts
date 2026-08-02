import { useCallback, useEffect, useRef, useState } from "react";
import { describeError } from "../backend-error";
import {
  translate,
  type Translation,
  type TranslationInput,
} from "./translate";

/**
 * One translation at a time (issue #10).
 *
 * The panel shows whichever request the reader started last, so an earlier one
 * that finishes late is dropped rather than replacing what they are reading.
 */

export interface TranslationSource {
  /** What was sent, kept so a failed translation can be retried as-is. */
  input: TranslationInput;
  /** Page the selection is on, for the note the result can be inserted into. */
  page: number;
}

export type TranslationState =
  | { status: "idle" }
  | { status: "loading"; source: TranslationSource }
  | { status: "done"; source: TranslationSource; result: Translation }
  | { status: "error"; source: TranslationSource; message: string };

export interface UseTranslationResult {
  state: TranslationState;
  start(source: TranslationSource): void;
  /** Runs the last failed translation again; ignored in any other state. */
  retry(): void;
  dismiss(): void;
}

export function useTranslation(): UseTranslationResult {
  const [state, setState] = useState<TranslationState>({ status: "idle" });
  /** Identifies the newest request, so a stale answer can be recognized. */
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const start = useCallback((source: TranslationSource) => {
    const request = requestRef.current + 1;
    requestRef.current = request;
    setState({ status: "loading", source });

    const isCurrent = () =>
      mountedRef.current && requestRef.current === request;
    void translate(source.input)
      .then((result) => {
        if (isCurrent()) setState({ status: "done", source, result });
      })
      .catch((cause: unknown) => {
        if (isCurrent()) {
          setState({ status: "error", source, message: describeError(cause) });
        }
      });
  }, []);

  /** The state a callback should read, without re-creating the callback. */
  const stateRef = useRef(state);
  stateRef.current = state;

  const retry = useCallback(() => {
    const current = stateRef.current;
    if (current.status === "error") start(current.source);
  }, [start]);

  const dismiss = useCallback(() => {
    // Bumped so an answer already in flight cannot reopen the panel.
    requestRef.current += 1;
    setState({ status: "idle" });
  }, []);

  return { state, start, retry, dismiss };
}
