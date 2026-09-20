import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "./database-url";

/**
 * Guards the feedback loop itself. The workflow cannot be run from here, so
 * what is checked is the part of it that has actually gone wrong before: a
 * check quietly dropped, or allowed to fail without failing the job.
 *
 * The setup script is run for real, twice, against a throwaway database —
 * idempotence is the whole point of it and is not visible by reading it.
 */
const WORKFLOW = join(process.cwd(), "..", ".github", "workflows", "ci.yml");

/**
 * The `run:` steps of the single job, each with the directory it runs in.
 * Enough structure to assert on without a YAML parser: steps are the only
 * list in the file whose items sit at this indent.
 */
function steps(): { run: string; workingDirectory?: string }[] {
  return readFileSync(WORKFLOW, "utf8")
    .split(/^ {6}- /m)
    .slice(1)
    .flatMap((block) => {
      const run = block.match(/^\s*run: (.+)$/m)?.[1]?.trim();
      if (!run) return [];
      return [{ run, workingDirectory: block.match(/^\s*working-directory: (.+)$/m)?.[1]?.trim() }];
    });
}

describe("CI workflow", () => {
  const workflow = () => readFileSync(WORKFLOW, "utf8");

  it("exists", () => {
    expect(existsSync(WORKFLOW), `${WORKFLOW} is missing`).toBe(true);
  });

  it("runs on push and on pull request", () => {
    const source = workflow();
    expect(source).toMatch(/^\s{2}push:/m);
    expect(source).toMatch(/^\s{2}pull_request:/m);
  });

  it("runs all three checks", () => {
    const runs = steps().map((step) => step.run);
    expect(runs).toContain("npm run lint");
    expect(runs).toContain("npm run typecheck");
    expect(runs).toContain("npm test");
  });

  it("runs the three checks through the repo root's delegating scripts", () => {
    // CLAUDE.md documents `npm run lint`, `npm run typecheck` and `npm test`
    // from the repo root; root package.json forwards each into web/. That
    // forwarding is every agent's feedback loop, and a CI job that ran the
    // three inside web/ would stay green while the documented entry point was
    // broken. So the checks run where a developer runs them: the root.
    for (const check of ["npm run lint", "npm run typecheck", "npm test"]) {
      const step = steps().find((s) => s.run === check)!;
      expect(step.workingDirectory, `${check} must run at the repo root`).toBeUndefined();
    }

    // A job-level default would move them without touching a step.
    expect(workflow()).not.toMatch(/^\s*defaults:/m);
  });

  it("installs and prepares the database in web/", () => {
    // Those two are the only things the root has no script for.
    for (const command of ["npm ci", "npm run db:test:setup"]) {
      const step = steps().find((s) => s.run === command)!;
      expect(step?.workingDirectory, `${command} must run in web/`).toBe("web");
    }
  });

  it("lets none of them fail without failing the job", () => {
    // A skipped check is a failed check: neither `continue-on-error` nor a
    // swallowed exit code may appear anywhere in the job.
    expect(workflow()).not.toMatch(/continue-on-error/);
    expect(workflow()).not.toMatch(/\|\|\s*true/);
  });

  it("runs the suite against a real Postgres 15, not a stub", () => {
    const source = workflow();
    expect(source).toMatch(/image: postgres:15/);
    expect(source).toMatch(/TEST_DATABASE_URL:/);
    expect(source).toMatch(/lipi_test/);
  });

  it("needs no repository secret", () => {
    // The suite stubs OpenRouter and Composio itself in test/setup.ts, so a
    // fork's pull request has to be able to run this with no secrets at all.
    expect(workflow()).not.toMatch(/secrets\./);
  });

  it("only runs commands the package.json of the directory it runs in defines", () => {
    // The other half of running the checks at the root: every one of them is a
    // script that has to be there. Drop `lint` from the root package.json and
    // the workflow above still reads correctly while the job dies on its
    // fourth step — so the two files are asserted against each other rather
    // than each against itself.
    const scripts = (directory: string): string[] =>
      Object.keys(
        JSON.parse(readFileSync(join(process.cwd(), "..", directory, "package.json"), "utf8")).scripts ?? {},
      );

    for (const step of steps()) {
      // `npm ci` installs rather than running anything.
      const name = step.run.match(/^npm (?:run )?([\w:-]+)$/)?.[1];
      if (!name || name === "ci") continue;

      expect(scripts(step.workingDirectory ?? "."), `${step.run} has no script to run`).toContain(name);
    }
  });
});

describe("db:test:setup", () => {
  // A throwaway database, named so the suite's own `lipi_test` guard would
  // accept it — the script is meant to be run against exactly this shape of
  // name and nothing else.
  const probe = new URL(testDatabaseUrl);
  probe.pathname = "/lipi_test_setup_probe";

  const maintenance = new URL(testDatabaseUrl);
  maintenance.pathname = "/postgres";

  async function sql(statement: string) {
    const client = new Client({ connectionString: maintenance.toString() });
    await client.connect();
    try {
      return await client.query(statement);
    } finally {
      await client.end();
    }
  }

  const exists = async () =>
    (await sql(`SELECT 1 FROM pg_database WHERE datname = 'lipi_test_setup_probe'`)).rowCount === 1;

  const run = (url: string) =>
    execFileSync("npx", ["tsx", "scripts/setup-test-db.ts"], {
      env: { ...process.env, TEST_DATABASE_URL: url },
      stdio: "pipe",
      timeout: 60_000,
    }).toString();

  const drop = () => sql(`DROP DATABASE IF EXISTS lipi_test_setup_probe`);

  beforeAll(drop);
  afterAll(drop);

  it("creates the database and applies every migration", async () => {
    expect(await exists()).toBe(false);

    const output = run(probe.toString());

    expect(output).toContain("Created database lipi_test_setup_probe");
    expect(await exists()).toBe(true);

    // The applied migrations, not just an empty database with a name.
    const applied = new Client({ connectionString: probe.toString() });
    await applied.connect();
    try {
      const { rows } = await applied.query<{ count: string }>(
        `SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
      );
      expect(Number(rows[0]!.count)).toBeGreaterThan(0);
    } finally {
      await applied.end();
    }
  }, 90_000);

  it("is a no-op the second time", () => {
    const output = run(probe.toString());

    expect(output).toContain("already exists");
    expect(output).not.toContain("Created database");
  }, 90_000);

  it("refuses a database that is not a test database", () => {
    // The guard that keeps `npm run db:test:setup` from running migrations
    // over a developer's lipi_dev, which is the one mistake it could make.
    const dev = new URL(testDatabaseUrl);
    dev.pathname = "/lipi_dev";

    let status = 0;
    let stderr = "";
    try {
      run(dev.toString());
    } catch (error) {
      const failed = error as { status?: number; stderr?: Buffer };
      status = failed.status ?? -1;
      stderr = failed.stderr?.toString() ?? "";
    }

    expect(status).toBe(1);
    expect(stderr).toContain("lipi_test");
  }, 90_000);
});
