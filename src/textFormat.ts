export function normalized(text: string) {
  return text.replaceAll(/\r\n?/g, "\n");
}
