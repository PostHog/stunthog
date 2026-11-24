import {
  type ResponseCapture,
  type ResponseRule,
  type Rewrite,
  rewriteResponse,
  type ToolCall,
} from "../domain/response-override.js";

export async function deliverResponse<T>(
  rules: ResponseRule[],
  call: ToolCall,
  original: T,
  callId: string,
  route: string,
  record?: (capture: ResponseCapture) => Promise<void>,
  rewrite?: Rewrite,
): Promise<T> {
  const { value, ruleId, error, ...evidence } = await (
    rewrite ?? rewriteResponse
  )(rules, call, original);
  // Keep both sides of every edit. Large inputs can be recovered from the harness trace.
  const inputOmitted = JSON.stringify(call.args).length > 32_000;
  if (ruleId || (!inputOmitted && JSON.stringify(original).length <= 256_000)) {
    await record?.({
      ...call,
      ...evidence,
      ...(inputOmitted && { args: {}, inputOmitted: true }),
      callId,
      route,
      original,
      ...(ruleId && { ruleId, delivered: value }),
      ...(error && { error }),
    });
  }
  return value as T;
}

export function deliverShellResponse(
  rules: ResponseRule[],
  command: string,
  output: string,
  callId: string,
  record?: (capture: ResponseCapture) => Promise<void>,
  rewrite?: Rewrite,
) {
  if (!command.trim() || command.length > 64_000)
    return Promise.resolve(output);
  return deliverResponse(
    rules,
    {
      target: { kind: "shell", match: "batch", command: command.trim() },
      args: { command },
    },
    output,
    callId,
    "Shell",
    async (capture) => {
      if (capture.ruleId || capture.error || capture.decisions?.length)
        await record?.(capture);
    },
    rewrite,
  );
}
