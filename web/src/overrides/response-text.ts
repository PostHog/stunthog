export const displayResponse = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
export function previewText(value: unknown, path: string) {
  if (value && typeof value === "object") {
    if (path && "structuredContent" in value)
      return displayResponse(value.structuredContent);
    const content = "content" in value ? value.content : value;
    if (Array.isArray(content)) {
      const text = content
        .filter((block) => block?.type === "text")
        .map((block) => block.text);
      if (text.length) return text.join("\n\n");
    }
  }
  return displayResponse(value);
}
