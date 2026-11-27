import { useCallback, useEffect, useRef, useState } from "react";
import { analyticsHeaders, posthog } from "./analytics.js";

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...analyticsHeaders(),
      ...options?.headers,
    },
  });
  const result: unknown = await response.json();

  if (!response.ok) {
    const error = new Error(
      result && typeof result === "object" && "message" in result
        ? String(result.message)
        : "The request failed.",
    );

    posthog.captureException(error, {
      api_path: path,
      status: response.status,
    });
    posthog.logger.error("API request failed", {
      api_path: path,
      status: response.status,
    });
    throw error;
  }

  return result as T;
}

// Each screen owns its request. Abort previous requests when navigation changes the resource.
export function useApi<T>(
  path: string,
  poll: boolean | ((value: T) => boolean) = false,
) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const previousPath = useRef(path);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;

    setLoading(true);

    if (previousPath.current !== path) setData(undefined);

    previousPath.current = path;

    const load = async () => {
      if (pending) return;

      pending = true;

      try {
        const value = await api<T>(
          `${path}${path.includes("?") ? "&" : "?"}refresh=${revision}`,
          { signal: controller.signal, cache: "no-store" },
        );
        if (!controller.signal.aborted) {
          if (typeof poll === "function" && !poll(value)) clearInterval(timer);
          setData(value);
          setError("");
        }
      } catch (error) {
        if (!controller.signal.aborted) setError(String(error));
      } finally {
        pending = false;

        if (!controller.signal.aborted) setLoading(false);
      }
    };

    const timer = poll ? setInterval(() => void load(), 2000) : undefined;
    void load();

    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [path, poll, revision]);

  return { data, error, refresh, loading };
}
