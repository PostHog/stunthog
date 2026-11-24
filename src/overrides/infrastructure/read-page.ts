import { z } from "zod";
import type {
  ResponseCapture,
  ResponseRule,
  Rewrite,
} from "../domain/response-override.js";
import { deliverResponse } from "./deliver.js";
export async function readPage(
  url: string,
  signal?: AbortSignal,
): Promise<{ url: string; body: string; truncated: boolean }> {
  const target = z
    .string()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), "Use an HTTP or HTTPS URL.")
    .parse(url);
  const signals = [AbortSignal.timeout(30_000), ...(signal ? [signal] : [])];
  const response = await fetch(target, { signal: AbortSignal.any(signals) });

  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${response.url || target}`);

  const reader = response.body?.getReader();

  if (!reader) throw new Error("The page has no response body.");

  const decoder = new TextDecoder();
  let text = "";

  try {
    while (text.length < 50_000) {
      const chunk = await reader.read();

      if (chunk.done)
        return {
          url: response.url || target,
          body: text + decoder.decode(),
          truncated: false,
        };

      text += decoder.decode(chunk.value, { stream: true });
    }

    return {
      url: response.url || target,
      body: text.slice(0, 50_000),
      truncated: true,
    };
  } finally {
    await reader.cancel();
  }
}

export async function fetchPage(
  url: string,
  signal?: AbortSignal,
  rules: ResponseRule[] = [],
  id = "",
  record?: (capture: ResponseCapture) => Promise<void>,
  route = "web_fetch",
  rewrite?: Rewrite,
) {
  const page = await readPage(url, signal);
  const body = await deliverResponse(
    rules,
    { target: { kind: "web", url }, args: { url } },
    page.body,
    id,
    route,
    record,
    rewrite,
  );
  return `URL: ${page.url}\n\n${body}${page.truncated ? "\n[Response truncated at 50,000 characters.]" : ""}`;
}
