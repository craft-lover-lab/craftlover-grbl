import { useCallback, useRef, useState } from 'react';

/**
 * State with undo / redo.
 * - set(): live update without recording history — used while dragging
 * - checkpoint(): record the current state before a change
 * - commit(): checkpoint + set, for single-step operations
 */
export function useHistory<T>(initial: T, limit = 200) {
  const [state, setState] = useState(initial);
  const cur = useRef(state);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const [, bump] = useState(0);

  const set = useCallback((v: T | ((old: T) => T)) => {
    setState((old) => {
      const next = typeof v === 'function' ? (v as (o: T) => T)(old) : v;
      cur.current = next;
      return next;
    });
  }, []);

  const checkpoint = useCallback(() => {
    if (past.current[past.current.length - 1] === cur.current) return;
    past.current.push(cur.current);
    if (past.current.length > limit) past.current.shift();
    future.current = [];
    bump((n) => n + 1);
  }, [limit]);

  const commit = useCallback(
    (v: T | ((old: T) => T)) => {
      checkpoint();
      set(v);
    },
    [checkpoint, set],
  );

  const undo = useCallback(() => {
    const p = past.current.pop();
    if (p === undefined) return;
    future.current.push(cur.current);
    cur.current = p;
    setState(p);
  }, []);

  const redo = useCallback(() => {
    const n = future.current.pop();
    if (n === undefined) return;
    past.current.push(cur.current);
    cur.current = n;
    setState(n);
  }, []);

  /** Replace everything (e.g. opening a project) and clear the history. */
  const reset = useCallback((v: T) => {
    past.current = [];
    future.current = [];
    cur.current = v;
    setState(v);
  }, []);

  return { state, set, checkpoint, commit, undo, redo, reset, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}
