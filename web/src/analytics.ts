import posthog from "posthog-js";
import { z } from "zod";

const token = import.meta.env.VITE_PUBLIC_POSTHOG_KEY;
const host = import.meta.env.VITE_PUBLIC_POSTHOG_HOST;

export let analyticsEnabled = false;

export async function initializeAnalytics(): Promise<void> {
  if (analyticsEnabled || !token || !host) return;

  try {
    const response = await fetch("/api/analytics/identity", {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return;
    const { distinctId } = z
      .object({ distinctId: z.string().uuid() })
      .parse(await response.json());

    posthog.init(token, {
      api_host: host,
      defaults: "2026-08-30",
      // SQLite owns identity; browser storage must not reuse another localhost app's ID.
      persistence: "memory",
      bootstrap: { distinctID: distinctId, isIdentifiedID: false },
      person_profiles: "always",
      capture_exceptions: true,
      logs: { captureConsoleLogs: true, serviceName: "stunthog-frontend" },
    });
    analyticsEnabled = true;
  } catch {
    // Keep the app usable if identity cannot load, without sending misattributed events.
  }
}

export function analyticsHeaders(): Record<string, string> {
  return analyticsEnabled
    ? {
        "X-POSTHOG-DISTINCT-ID": posthog.get_distinct_id(),
        "X-POSTHOG-SESSION-ID": posthog.get_session_id(),
      }
    : {};
}

export { posthog };
