/** The text to show for a caught error: its message, as the server or browser wrote it. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
