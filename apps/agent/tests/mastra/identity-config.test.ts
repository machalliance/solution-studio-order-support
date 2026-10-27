// The demo customer's and the support rep's names come ONLY from .env — the code ships with no name or address for either
// (so no real person's details are baked into the repository). The agent refuses to start without them, and serves the
// rep's name to the Escalation Desk at GET /rep.
// Run with: npx tsx --test --test-force-exit tests/mastra/identity-config.test.ts (from apps/agent)

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "wismo-identity-"));
process.env.AGENT_DB_URL = `file:${join(dir, "test.db")}`;
process.env.WISMO_DEMO_CUSTOMER_NAME = "  Test Customer  ";
process.env.WISMO_DEMO_CUSTOMER_EMAIL = "test.customer@example.com";
process.env.WISMO_REP_NAME = "Test Rep";

const { assertIdentityConfigured } = await import("../../src/config");
const { customers } = await import("../../src/fixtures/demo-data");
const { app } = await import("../../src/server");

describe("who the demo customer and the rep are", () => {
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("the agent refuses to start with nothing set, and names every missing variable", () => {
    assert.throws(() => assertIdentityConfigured({}), (error: Error) => {
      for (const name of ["WISMO_DEMO_CUSTOMER_NAME", "WISMO_DEMO_CUSTOMER_EMAIL", "WISMO_REP_NAME"]) assert.match(error.message, new RegExp(name));
      assert.match(error.message, /\.env\.example/, "…and says where the values come from");
      return true;
    });
  });

  test("only the missing ones are named, and a blank value counts as missing", () => {
    assert.throws(
      () => assertIdentityConfigured({ WISMO_DEMO_CUSTOMER_NAME: "A B", WISMO_DEMO_CUSTOMER_EMAIL: "   ", WISMO_REP_NAME: "C D" }),
      (error: Error) => /WISMO_DEMO_CUSTOMER_EMAIL/.test(error.message) && !/WISMO_DEMO_CUSTOMER_NAME|WISMO_REP_NAME/.test(error.message)
    );
  });

  test("all three set is fine", () => {
    assert.doesNotThrow(() => assertIdentityConfigured({ WISMO_DEMO_CUSTOMER_NAME: "A B", WISMO_DEMO_CUSTOMER_EMAIL: "a@example.com", WISMO_REP_NAME: "C D" }));
  });

  test("the demo customer is exactly what .env says (trimmed) — nothing built in", () => {
    assert.equal(customers.cust_demo_01.name, "Test Customer");
    assert.equal(customers.cust_demo_01.email, "test.customer@example.com");
  });

  test("the storefront gets that customer from /me, and the Desk gets the rep from /rep", async () => {
    const me: any = await (await app.request("/me")).json();
    assert.equal(me.customer.name, "Test Customer");
    const rep: any = await (await app.request("/rep")).json();
    assert.deepEqual(rep, { name: "Test Rep" });
  });
});
