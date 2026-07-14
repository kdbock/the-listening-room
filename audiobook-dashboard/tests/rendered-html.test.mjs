import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("ships the finished durable audiobook tracker", async () => {
  const [page, dashboard, layout, hosting] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Dashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    access(new URL("../dist/server/index.js", import.meta.url)),
    access(new URL("../public/og.png", import.meta.url)),
  ]);
  assert.match(page, /<Dashboard/);
  assert.match(dashboard, /The Listening Room/);
  assert.match(dashboard, /Production gates/);
  assert.match(layout, /Audiobook Production Tracker/);
  assert.match(layout, /og\.png/);
  assert.equal(JSON.parse(hosting).d1, "DB");
  assert.doesNotMatch(page + dashboard + layout, /codex-preview|Your site is taking shape|react-loading-skeleton/);
});
