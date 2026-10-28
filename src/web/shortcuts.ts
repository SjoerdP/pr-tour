/** The tooltip of a button that has a keyboard shortcut: `withKey('Next step', 'j')` is "Next step (j)". */
export function withKey(label: string, key: string): string {
  return `${label} (${key})`;
}
