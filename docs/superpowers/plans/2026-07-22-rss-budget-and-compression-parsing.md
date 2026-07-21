# RSS Budget and Compression Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge v0.9.28 and make health responsive to sustained 512 MiB RSS pressure while accepting wrapped or escaped compression XML.

**Architecture:** Keep pure XML normalization in the prompt utility before compression field extraction. Keep sustained RSS state inside the health monitor, then overlay deterministic RSS alerts on the existing pure threshold result; the monitor never terminates the process.

**Tech Stack:** TypeScript, Node.js process memory APIs, Vitest, tsdown.

## Global Constraints

- RSS budget is exactly 512 MiB.
- RSS needs two consecutive over-budget samples before a GC request.
- Escalate only after three consecutive post-GC over-budget samples.
- Run GC only through optional `global.gc`; do not add dependencies or restart the process.
- Preserve required compression `type` and `title` validation.

---

### Task 1: Normalize compression XML

**Files:**
- Modify: `src/prompts/xml.ts`
- Modify: `src/functions/compress.ts`
- Test: `test/xml.test.ts`

**Interfaces:**
- Produces: `normalizeXmlResponse(xml: string): string`.
- Consumes: `getXmlTag` and `getXmlChildren` without changing their signatures.

- [ ] **Step 1: Write failing normalization tests**

```ts
it("normalizes fenced, prose-wrapped, and escaped XML", () => {
  const xml = "Reply:\n```xml\n&lt;type&gt;file_read&lt;/type&gt;\n&lt;title&gt;Read file&lt;/title&gt;\n```\nDone";
  const normalized = normalizeXmlResponse(xml);
  expect(getXmlTag(normalized, "type")).toBe("file_read");
  expect(getXmlTag(normalized, "title")).toBe("Read file");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/xml.test.ts`

Expected: FAIL because `normalizeXmlResponse` is not exported.

- [ ] **Step 3: Implement normalization and use it before parsing**

```ts
export function normalizeXmlResponse(xml: string): string {
  const unfenced = xml.replace(/```\s*xml\s*\n?|```/gi, "");
  const decoded = unfenced.replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
  const start = decoded.indexOf("<observation>");
  const end = decoded.indexOf("</observation>");
  return start >= 0 && end >= start ? decoded.slice(start, end + "</observation>".length) : decoded;
}
```

Call `normalizeXmlResponse(xml)` at the start of `parseCompressionXml`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run test/xml.test.ts`

Expected: PASS.

### Task 2: Track sustained RSS pressure

**Files:**
- Modify: `src/health/monitor.ts`
- Test: `test/health-monitor.test.ts`

**Interfaces:**
- Produces: `registerHealthMonitor()` snapshots with `rss_warn_512mb`, `rss_gc_attempted_512mb`, and `rss_critical_512mb` alerts.
- Consumes: `process.memoryUsage()`, optional `global.gc`, and `evaluateHealth()`.

- [ ] **Step 1: Write failing monitor tests**

```ts
it("does not degrade for one RSS breach", async () => {
  memoryUsage.mockReturnValue(memory(513));
  const snapshot = await collect();
  expect(snapshot.status).toBe("healthy");
});

it("requests GC after the second RSS breach and escalates after three post-GC breaches", async () => {
  memoryUsage.mockReturnValue(memory(513));
  await collect();
  await collect();
  await collect();
  await collect();
  const snapshot = await collect();
  expect(gc).toHaveBeenCalledOnce();
  expect(snapshot.status).toBe("critical");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/health-monitor.test.ts`

Expected: FAIL because the monitor has no persistent RSS state or GC behavior.

- [ ] **Step 3: Implement bounded RSS state**

```ts
const RSS_BUDGET_BYTES = 512 * 1024 * 1024;
let rssBreaches = 0;
let postGcBreaches = 0;
let gcRequested = false;

if (snapshot.memory.rss > RSS_BUDGET_BYTES) {
  rssBreaches++;
  if (rssBreaches === 2 && !gcRequested) {
    gcRequested = true;
    global.gc?.();
  } else if (gcRequested && rssBreaches > 2) {
    postGcBreaches++;
  }
} else {
  rssBreaches = 0;
  postGcBreaches = 0;
  gcRequested = false;
}
```

After `evaluateHealth`, set degraded with `rss_warn_512mb` for a sustained breach and critical with `rss_critical_512mb` after three post-GC breaches. Append `rss_gc_attempted_512mb` only on the GC-request sample.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npx vitest run test/health-monitor.test.ts test/health-thresholds.test.ts`

Expected: PASS.

### Task 3: Regenerate merge artifacts and validate

**Files:**
- Modify: `plugin/scripts/*.mjs` via `npm run build`
- Modify: `CHANGELOG.md` merge resolution

- [ ] **Step 1: Regenerate hook bundles**

Run: `npm run build`

Expected: exit 0; generated hook bundles include both null payload guards and top-level error guards.

- [ ] **Step 2: Run validation**

Run: `npm test && npx tsc --noEmit && npm run build && git diff --check`

Expected: every command exits 0 and no conflict markers or whitespace errors remain.

- [ ] **Step 3: Commit the requested merge**

Run: `git add -A && git commit`

Expected: Git creates a merge commit containing v0.9.28, the conflict resolutions, RSS behavior, XML parsing fix, tests, and generated hook bundles.
