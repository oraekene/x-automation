import { describe, expect, it } from "vitest";
import { addIntervalInZone, zoneOffsetMs } from "../src/lib/time";

describe("zoneOffsetMs", () => {
  it("is zero for UTC year-round", () => {
    expect(zoneOffsetMs("UTC", Date.UTC(2025, 0, 15))).toBe(0);
    expect(zoneOffsetMs("UTC", Date.UTC(2025, 6, 15))).toBe(0);
  });

  it("resolves New York as EST in January and EDT in July", () => {
    expect(zoneOffsetMs("America/New_York", Date.UTC(2025, 0, 15, 12))).toBe(-5 * 3_600_000);
    expect(zoneOffsetMs("America/New_York", Date.UTC(2025, 6, 15, 12))).toBe(-4 * 3_600_000);
  });

  it("resolves Tokyo's fixed UTC+9", () => {
    expect(zoneOffsetMs("Asia/Tokyo", Date.UTC(2025, 6, 15, 12))).toBe(9 * 3_600_000);
  });
});

describe("addIntervalInZone", () => {
  it("advances exactly by minutes in UTC", () => {
    const now = Date.UTC(2025, 6, 15, 12, 0, 0);
    expect(addIntervalInZone(now, 60, "UTC")).toBe(now + 3_600_000);
    expect(addIntervalInZone(now, 1440, "UTC")).toBe(now + 24 * 3_600_000);
  });

  it("preserves the same wall-clock hour in a non-transition zone", () => {
    const now = Date.UTC(2025, 6, 15, 12, 0, 0);
    const next = addIntervalInZone(now, 1440, "America/New_York");
    expect(zoneOffsetMs("America/New_York", next)).toBe(zoneOffsetMs("America/New_York", now));
    expect(next).toBe(now + 24 * 3_600_000);
  });

  it("defaults a degenerate interval to one day", () => {
    const now = Date.UTC(2025, 6, 15, 12, 0, 0);
    expect(addIntervalInZone(now, 0, "UTC")).toBe(now + 24 * 3_600_000);
  });
});