import { api } from "../api.js";
export async function connectMcp(id: string) {
  const popup = window.open("about:blank", "_blank");
  if (!popup) throw new Error("Allow pop-ups to connect this MCP server.");
  popup.opener = null;
  popup.document.body.textContent = "Starting MCP authorization…";
  try {
    const { authorizationUrl } = await api<{ authorizationUrl: string }>(
      `/resources/${id}/connect`,
      { method: "POST" },
    );
    popup.location.replace(authorizationUrl);
  } catch (error) {
    popup.close();
    throw error;
  }
}
