/**
 * `url` when it is safe to link to: an absolute `https:` URL. Anything else (a
 * `javascript:` or `data:` URL from a third-party status target, a relative path, plain
 * `http:`) is null, and the caller shows plain text instead of a link.
 */
export function safeHref(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not an absolute URL: nothing to link to.
    return null;
  }
  return parsed.protocol === 'https:' ? url : null;
}
