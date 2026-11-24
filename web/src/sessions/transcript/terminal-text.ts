export function terminalText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal control sequences start with ESC or CSI.
  return text.replaceAll(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "");
}
