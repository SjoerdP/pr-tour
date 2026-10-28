// Syntax highlighting for the code view, with Shiki. Shiki and each language grammar
// load on first use, so the app's first render never waits for them.

import type { HighlighterGeneric } from 'shiki';

/** One coloured piece of a line. `color` is absent for plain text. */
export type Token = { content: string; color?: string };
export type HighlightedLine = Token[];

const THEMES = { light: 'github-light', dark: 'github-dark' } as const;

/** Above this size highlighting costs more than it is worth; the file is shown plain. */
const MAX_CHARS = 100_000;

/** File names without a useful extension that still have a grammar. */
const NAMED: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Shiki's generic language/theme ids
type Highlighter = HighlighterGeneric<any, any>;

let highlighter: Promise<{ shiki: typeof import('shiki'); hl: Highlighter }> | null = null;

function loadShiki() {
  highlighter ??= import('shiki').then(async (shiki) => ({
    shiki,
    // The JavaScript regex engine needs no WebAssembly download.
    hl: await shiki.createHighlighter({
      themes: Object.values(THEMES),
      langs: [],
      engine: shiki.createJavaScriptRegexEngine(),
    }),
  }));
  return highlighter;
}

function plain(text: string): HighlightedLine[] {
  return text.split('\n').map((content) => [{ content }]);
}

/** Shiki's language id for `path`, or null when there is none. */
function languageOf(path: string, shiki: typeof import('shiki')): string | null {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  if (NAMED[name]) return NAMED[name];
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = name.slice(dot + 1);
  const known = shiki.bundledLanguagesInfo.some(
    (info) => info.id === ext || (info.aliases ?? []).includes(ext),
  );
  return known ? ext : null;
}

/**
 * `text` split into lines of coloured tokens, one entry per line of `text`. The language
 * comes from the file extension; unknown languages, very large files and any Shiki failure
 * give plain text, so the code is always shown.
 */
export async function highlight(
  text: string,
  path: string,
  theme: 'light' | 'dark',
): Promise<HighlightedLine[]> {
  if (text.length > MAX_CHARS) return plain(text);
  try {
    const { shiki, hl } = await loadShiki();
    const lang = languageOf(path, shiki);
    if (lang === null) return plain(text);
    await hl.loadLanguage(lang);
    return hl
      .codeToTokensBase(text, { lang, theme: THEMES[theme] })
      .map((line) => line.map((t) => ({ content: t.content, color: t.color })));
  } catch (err) {
    // Highlighting is a nicety: show the code plain rather than not at all.
    console.warn(`pr-tour: could not highlight ${path}`, err);
    return plain(text);
  }
}
