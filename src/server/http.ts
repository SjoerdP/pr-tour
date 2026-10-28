// Request helpers shared by the API routes: refusals, params and bodies.

import type { Context } from 'hono';
import { z } from 'zod';

/** A request the API refuses, with the status to answer. The message is shown to the user. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** GitHub stores PR numbers as 32-bit signed ints. */
const MAX_PR = 2147483647;

/** An owner or repo name: what GitHub allows, and never `.` or `..`. */
const NamePartSchema = z
  .string()
  .regex(/^[\w.-]+$/)
  .refine((part) => !/^\.+$/.test(part));

const PrParamsSchema = z.object({
  owner: NamePartSchema,
  name: NamePartSchema,
  pr: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .transform(Number)
    .refine((pr) => pr <= MAX_PR),
});

/** `value` checked against `schema`; a mismatch is a 400 naming `what`. */
export function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, `Invalid ${what}`);
  return result.data;
}

/**
 * The `:owner/:name/:pr` params as `{ repo, pr, key }`; `key` names the PR's build job.
 * `repo` is lowercased: GitHub names ignore case, so `Acme/Greet` is the same PR and tour.
 */
export function prParams(c: Context) {
  const { owner, name, pr } = parse(PrParamsSchema, c.req.param(), 'PR in the URL');
  const repo = `${owner}/${name}`.toLowerCase();
  return { repo, pr, key: `${repo}#${pr}` };
}

/** The request body as JSON checked against `schema`. */
export async function jsonBody<T>(c: Context, schema: z.ZodType<T>, what: string): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
  return parse(schema, json, what);
}

/** Like `jsonBody`, but an empty or missing body counts as `{}`. */
export async function optionalJsonBody<T>(
  c: Context,
  schema: z.ZodType<T>,
  what: string,
): Promise<T> {
  const text = await c.req.text();
  if (text.trim() === '') return parse(schema, {}, what);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
  return parse(schema, json, what);
}
