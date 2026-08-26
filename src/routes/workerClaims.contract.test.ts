/**
 * A queue drain must be able to tell a FAULT from an EMPTY QUEUE.
 *
 * Every one of these workers claims work the same way: select candidates, then
 * a conditional UPDATE that wins or loses a race. PostgREST resolves to
 * `{ data: null, error }` on any failure — and `data: null` is *also* what an
 * empty queue and a lost race look like. A claim written as `const { data } =`
 * therefore reports a database fault as "nothing to do": the worker returns
 * success, the queue never drains, and there is no failing request to find.
 *
 * The prime records this as fault 3 of four stacked faults in
 * `docs/aml/SCREENING_EXECUTION.md` — "the claim's error was discarded, so a
 * database fault was indistinguishable from losing a race". All three workers
 * here had it. It was inert in two of them only because they had never been
 * scheduled, which stopped being true on 26 Aug.
 *
 * This is a source contract rather than a unit test because these are route
 * modules: `createFileRoute` pulls in the router and `supabaseAdmin` is bound at
 * module scope, so the cheap, honest check is to read what the file says.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTES = join(__dirname);
const read = (f: string) => readFileSync(join(ROUTES, f), "utf8");

/**
 * The body of a named `async function`, by brace counting.
 *
 * The body brace is the one introduced by `) {` or `> {` — the latter because
 * two of these functions declare a multi-line return type
 * (`Promise<null | {\n … \n}> {`) whose own braces would otherwise be mistaken
 * for the body, and whose `}>` sits in column 0 so a scan for a line-initial
 * `}` ends at the signature.
 */
function bodyOf(source: string, fnName: string): string {
  const at = source.indexOf(`async function ${fnName}(`);
  expect(at, `${fnName} not found — if it was renamed, update this test`).toBeGreaterThan(-1);

  const opener = /[)>]\s\{/g;
  opener.lastIndex = at;
  const m = opener.exec(source);
  expect(m, `${fnName}: could not find the brace that opens its body`).not.toBeNull();
  const start = m!.index + m![0].length - 1;

  let braces = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") braces++;
    else if (source[i] === "}" && --braces === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${fnName}: unbalanced braces`);
}

/** Every `const { data… } = await` in a body, with whether it names `error`. */
function destructures(body: string): { text: string; checksError: boolean }[] {
  return [...body.matchAll(/const \{\s*data[^}]*\} = await/g)].map((m) => ({
    text: m[0],
    checksError: /\berror\b/.test(m[0]),
  }));
}

const WORKERS: Array<{ file: string; fn: string; what: string }> = [
  {
    file: "hooks.backend-provisioning-drain.tsx",
    fn: "claimOne",
    what: "the clone's own Supabase project",
  },
  { file: "hooks.cascade-drain.tsx", fn: "claimOne", what: "code into the clone's repo" },
  { file: "hooks.deployment-drain.tsx", fn: "claim", what: "the Vercel deployment" },
];

describe("a queue claim never reports a fault as an empty queue", () => {
  for (const { file, fn, what } of WORKERS) {
    it(`${file} · ${fn}() checks the error on every statement (${what})`, () => {
      const body = bodyOf(read(file), fn);
      const stmts = destructures(body);
      expect(
        stmts.length,
        "no destructured awaits found — did the claim change shape?",
      ).toBeGreaterThan(0);
      const unchecked = stmts.filter((s) => !s.checksError).map((s) => s.text);
      expect(unchecked, `discards its error: ${unchecked.join(" | ")}`).toEqual([]);
    });

    it(`${file} · ${fn}() fails loudly rather than returning nothing`, () => {
      // Silence is the one outcome that converges nowhere: the route's catch
      // turns a throw into a non-200, which is visible in net._http_response.
      expect(bodyOf(read(file), fn)).toMatch(/throw new Error\(/);
    });
  }
});

describe("the deployment worker's other queue reads say when they could not read", () => {
  // These two do NOT throw: the claim work above them has already succeeded and
  // is worth keeping. They name the failure in the response instead — which is
  // the whole point, because `checked: 0` and "nothing was due" are the same
  // sentence otherwise, and this sweep is the backup for a webhook that was
  // never delivered.
  //
  // Scoped to the QUEUE read specifically, not every read in the body. The
  // sweep also looks up a clone's display name for a notification, and
  // discarding THAT error is correct: it is rendered as `clone?.name ??
  // row.clone_id`, so a failed lookup costs a nicer word in a message, and
  // failing the notification over it would be worse. The rule is about a read
  // that decides whether there is work, not about every read.
  const QUEUE_OF: Record<string, string> = {
    sweepLiveBuilds: "clone_deployments",
    processTeardowns: "hosting_teardowns",
  };

  for (const [fn, table] of Object.entries(QUEUE_OF)) {
    it(`${fn}() checks the error on its ${table} read`, () => {
      const body = bodyOf(read("hooks.deployment-drain.tsx"), fn);
      const re = new RegExp(
        `const \\{\\s*data[^}]*\\} = await[\\s\\S]{0,120}?\\.from\\("${table}"\\)`,
      );
      const m = re.exec(body);
      expect(m, `${fn} no longer reads ${table} — update this test`).not.toBeNull();
      expect(m![0], `${fn} discards the error on its ${table} read`).toMatch(/\berror\b/);
    });

    it(`${fn}() returns that error rather than an empty result`, () => {
      expect(bodyOf(read("hooks.deployment-drain.tsx"), fn)).toMatch(/error: error\.message/);
    });
  }
});
