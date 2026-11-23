import { useCallback, useRef, useState } from 'react';

/**
 * Trạng thái có hoàn tác / làm lại.
 * - set(): cập nhật "trực tiếp" (không ghi lịch sử) — dùng khi đang kéo chuột
 * - checkpoint(): ghi trạng thái hiện tại vào lịch sử trước khi thay đổi
 * - commit(): checkpoint + set, dùng cho các thao tác một bước
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

  /** Thay toàn bộ (mở dự án mới) và xóa lịch sử. */
  const reset = useCallback((v: T) => {
    past.current = [];
    future.current = [];
    cur.current = v;
    setState(v);
  }, []);

  return { state, set, checkpoint, commit, undo, redo, reset, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}
