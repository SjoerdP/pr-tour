import { homeIds, type Range, type Tour } from './tour.js';

// Possible problems: warnings from CI and review bots, placed on the tour's homes.

/** How bad a possible problem is, worst first. */
export type Level = 'bug' | 'risk' | 'look';

export const LEVEL_LABEL: Record<Level, string> = {
  bug: 'Likely bug',
  risk: 'Risk',
  look: 'Worth a look',
};

export const LEVEL_ORDER: Level[] = ['bug', 'risk', 'look'];

/** What a problem is about: a line, a step (a failing test), a whole file, or the whole PR. */
export type ProblemAt =
  | { kind: 'line'; file: string; side: 'new' | 'old'; line: number }
  | { kind: 'step'; test: string }
  | { kind: 'file'; file: string }
  | { kind: 'pr' };

export type Problem = {
  /** Stable identity, used for marks. A bot thread's problem keeps the thread's key. */
  key: string;
  level: Level;
  title: string;
  why?: string;
  /** Who reported it, e.g. `CodeRabbit`, `golangci-lint`. */
  sources: string[];
  at: ProblemAt;
  url?: string;
  /** Set when the problem is a bot's review thread. */
  threadId?: string;
};

/** A problem with the home (foundation, step or other item) it belongs to, if any. */
export type PlacedProblem = Problem & { homeId: string | null };

type Home = { id: string; homes: Range[] };

/** Every home with its ranges: steps first, then foundations, then other items. */
function homesInPlaceOrder(tour: Tour): Home[] {
  return [
    ...tour.flows.flatMap((flow) => flow.steps),
    ...tour.foundations,
    ...tour.other.flatMap((g) => g.items),
  ];
}

function rangeHolds(r: Range, file: string, side: 'new' | 'old', line: number): boolean {
  return !('whole' in r) && r.file === file && r.side === side && r.start <= line && line <= r.end;
}

function placeOne(tour: Tour, at: ProblemAt): string | null {
  const steps = tour.flows.flatMap((flow) => flow.steps);
  switch (at.kind) {
    case 'line': {
      const step =
        at.side === 'new'
          ? steps.find((s) => s.file === at.file && s.startLine <= at.line && at.line <= s.endLine)
          : undefined;
      if (step) return step.id;
      const home = homesInPlaceOrder(tour).find((h) =>
        h.homes.some((r) => rangeHolds(r, at.file, at.side, at.line)),
      );
      return home?.id ?? null;
    }
    case 'step':
      return steps.find((s) => s.tests.some((t) => t.name === at.test))?.id ?? null;
    case 'file':
      return (
        homesInPlaceOrder(tour).find((h) => h.homes.some((r) => r.file === at.file))?.id ?? null
      );
    case 'pr':
      return null;
  }
}

/** Puts each problem on the home it is about; `homeId: null` when no home holds it. */
export function placeProblems(tour: Tour, problems: Problem[]): PlacedProblem[] {
  return problems.map((p) => ({ ...p, homeId: placeOne(tour, p.at) }));
}

const MERGE_DISTANCE = 2;

function worse(a: Level, b: Level): Level {
  return LEVEL_ORDER.indexOf(a) <= LEVEL_ORDER.indexOf(b) ? a : b;
}

/**
 * Folds a line problem without a thread (a CI annotation) into the nearest bot thread on
 * the same file and side, at most 2 lines away. The thread keeps its key, title, text and
 * place; it takes the worse level and both sources. Two problems without a thread never
 * merge, and two threads stay two threads: each shows as itself.
 */
export function mergeProblems(problems: Problem[]): Problem[] {
  const merged = new Map<Problem, Problem>();
  const absorbed = new Set<Problem>();
  const threads = problems.filter((p) => p.threadId !== undefined && p.at.kind === 'line');
  for (const p of problems) {
    if (p.threadId !== undefined || p.at.kind !== 'line') continue;
    const at = p.at;
    let best: Problem | undefined;
    let bestDistance = Infinity;
    for (const t of threads) {
      if (t.at.kind !== 'line' || t.at.file !== at.file || t.at.side !== at.side) continue;
      const distance = Math.abs(t.at.line - at.line);
      if (distance <= MERGE_DISTANCE && distance < bestDistance) {
        best = t;
        bestDistance = distance;
      }
    }
    if (!best) continue;
    const into = merged.get(best) ?? best;
    merged.set(best, {
      ...into,
      level: worse(into.level, p.level),
      sources: [...new Set([...into.sources, ...p.sources])],
    });
    absorbed.add(p);
  }
  return problems.filter((p) => !absorbed.has(p)).map((p) => merged.get(p) ?? p);
}

/** Worst level first, then PR-wide problems, then tour order (unplaced last), then line. */
export function sortProblems(tour: Tour, placed: PlacedProblem[]): PlacedProblem[] {
  const order = new Map(homeIds(tour).map((id, i) => [id, i]));
  const rank = (p: PlacedProblem): [number, number, number, number] => [
    LEVEL_ORDER.indexOf(p.level),
    p.at.kind === 'pr' ? 0 : 1,
    p.homeId === null ? Infinity : (order.get(p.homeId) ?? Infinity),
    p.at.kind === 'line' ? p.at.line : 0,
  ];
  const ranked = placed.map((p) => ({ p, r: rank(p) }));
  ranked.sort(({ r: a }, { r: b }) => a[0] - b[0] || a[1] - b[1] || cmp(a[2], b[2]) || a[3] - b[3]);
  return ranked.map(({ p }) => p);
}

/** Compares numbers that may be Infinity (Infinity - Infinity is NaN). */
function cmp(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Levels read from bot comments. The first match wins; a comment with no match is
 * `look`. Add a row to map another bot's label.
 */
const BOT_LEVELS: { match: string | RegExp; level: Level }[] = [
  // CodeRabbit: `_⚠️ Potential issue_`
  { match: 'Potential issue', level: 'risk' },
];

export function botLevel(body: string): Level {
  const row = BOT_LEVELS.find(({ match }) =>
    typeof match === 'string' ? body.includes(match) : match.test(body),
  );
  return row?.level ?? 'look';
}

/** Label lines bots put above the actual comment. */
const LABEL_LINES = ['_⚠️ Potential issue_', '_🛠️ Refactor suggestion_'];
/** A line of only emoji, `*` and `_` (and spaces). */
const DECORATION_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D|[*_\s])*$/u;
/** `**x**`, `__x__`, `*x*`, `_x_` or `` `x` `` around words, not inside them (snake_case stays). */
const MARKDOWN_AROUND = /(?<![\w*_`])(\*\*|__|\*|_|`)(?=\S)(.+?)(?<=\S)\1(?![\w*_`])/gu;
const TITLE_MAX = 100;

/** A short title for a bot comment: its first line that says something, without markdown. */
export function botTitle(body: string): string {
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => !LABEL_LINES.includes(l) && !DECORATION_ONLY.test(l));
  if (line === undefined) return '';
  let title = line;
  for (let prev = ''; prev !== title;) {
    prev = title;
    title = title.replace(MARKDOWN_AROUND, '$2');
  }
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1).trimEnd()}…` : title;
}

/** Whether a GitHub login is a bot's, by its `[bot]` suffix. */
export function isBotLogin(login: string): boolean {
  return login.endsWith('[bot]');
}
