import { describe, expect, it, vi } from "vitest";
import { createRssBudgetTracker } from "../src/health/monitor.js";

const MEBIBYTE = 1024 * 1024;

describe("createRssBudgetTracker", () => {
  it("ignores one RSS breach and requests GC after a second breach", () => {
    const gc = vi.fn();
    const tracker = createRssBudgetTracker(gc);

    expect(tracker(513 * MEBIBYTE)).toEqual({ status: "healthy", alerts: [] });
    expect(tracker(513 * MEBIBYTE)).toEqual({
      status: "degraded",
      alerts: ["rss_warn_512mb", "rss_gc_attempted_512mb"],
    });
    expect(gc).toHaveBeenCalledOnce();
  });

  it("escalates after three RSS breaches following GC", () => {
    const tracker = createRssBudgetTracker(vi.fn());

    tracker(513 * MEBIBYTE);
    tracker(513 * MEBIBYTE);
    tracker(513 * MEBIBYTE);
    tracker(513 * MEBIBYTE);

    expect(tracker(513 * MEBIBYTE)).toEqual({
      status: "critical",
      alerts: ["rss_critical_512mb"],
    });
  });

  it("resets after RSS returns within budget", () => {
    const gc = vi.fn();
    const tracker = createRssBudgetTracker(gc);

    tracker(513 * MEBIBYTE);
    tracker(513 * MEBIBYTE);
    expect(tracker(512 * MEBIBYTE)).toEqual({ status: "healthy", alerts: [] });
    expect(tracker(513 * MEBIBYTE)).toEqual({ status: "healthy", alerts: [] });
    expect(gc).toHaveBeenCalledOnce();
  });

  it("records an unavailable GC after sustained RSS pressure", () => {
    const tracker = createRssBudgetTracker();

    tracker(513 * MEBIBYTE);

    expect(tracker(513 * MEBIBYTE)).toEqual({
      status: "degraded",
      alerts: ["rss_warn_512mb", "rss_gc_unavailable_512mb"],
    });
  });
});
