import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { EventRow } from "../types.js";

type View = "agent" | "judge" | "intercepts";
export function useSessionEvents(
  id: string,
  view: View,
  enabled: boolean,
  active: boolean,
) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const loadRef = useRef<(through?: number) => Promise<void>>(async () => {});
  const atEnd = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    let cursor = 0;
    let task: Promise<void> | undefined;
    let target = 0;
    async function page() {
      try {
        setError("");
        do {
          const rows = await api<EventRow[]>(
            `/sessions/${id}/events?after=${cursor}&view=${view}`,
            { signal: abort.signal },
          );
          if (abort.signal.aborted) return;
          const next = rows.at(-1)?.sequence ?? cursor;
          atEnd.current = rows.length < 100 || next <= cursor;
          if (next > cursor) {
            cursor = next;
            setEvents((previous) => [...previous, ...rows]);
          }
          setMore(!atEnd.current);
        } while (!atEnd.current && (view === "intercepts" || cursor < target));
      } catch (e) {
        if (!abort.signal.aborted) setError(String(e));
      } finally {
        task = undefined;
        target = 0;
      }
    }
    const load = (through = 0) => {
      target = Math.max(target, through);
      task ??= page();
      return task;
    };
    loadRef.current = load;
    setEvents([]);
    setMore(false);
    atEnd.current = false;
    void load();
    return () => {
      abort.abort();
      loadRef.current = async () => {};
    };
  }, [id, view, enabled]);
  useEffect(() => {
    if (!enabled) return;
    // Read once on completion to collect events written between polls.
    if (atEnd.current) void loadRef.current();
    if (!active) return;
    const timer = setInterval(() => {
      if (atEnd.current) void loadRef.current();
    }, 2000);
    return () => clearInterval(timer);
  }, [active, enabled]);
  return {
    events,
    error,
    more,
    load: (through?: number) => loadRef.current(through),
  };
}
