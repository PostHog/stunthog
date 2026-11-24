import { Button } from "@posthog/quill";
import { useEffect, useState } from "react";
import { useApi } from "../api.js";
import { connectMcp } from "./connect-mcp.js";
export function McpConnection({ id }: { id: string }) {
  const { data, error, refresh, loading } = useApi<{
    status: "ready" | "authorization" | "unavailable";
  }>(`/resources/${id}/connection`);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);
  return (
    <div>
      <output>
        {loading
          ? "Checking MCP connection…"
          : data?.status === "ready"
            ? "Connected"
            : data?.status === "authorization"
              ? "This server requires authorization."
              : "Cannot connect to this server."}
      </output>
      {data?.status === "authorization" && (
        <Button
          type="button"
          onClick={() => {
            setFailure("");
            void connectMcp(id).catch((err) => setFailure(String(err)));
          }}
        >
          Connect
        </Button>
      )}
      {(error || data?.status === "unavailable") && (
        <Button type="button" onClick={refresh}>
          Check connection
        </Button>
      )}
      {failure && <span role="alert">{failure}</span>}
    </div>
  );
}
