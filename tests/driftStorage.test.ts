import { describe, it, expect, beforeEach } from "vitest";
import { StorageManager } from "../src/lib/storage";
import type { DriftAnchor } from "../src/lib/drift";

/**
 * Minimal in-memory browser.storage.local mock.
 * Keys are flat (string keys) with object values, mirroring the WebExtension API.
 */
function makeStorageMock(): { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  (globalThis as any).browser = {
    storage: {
      local: {
        get: async (keys: string | string[]) => {
          const out: Record<string, unknown> = {};
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const k of keyList) {
            if (store.has(k)) out[k] = JSON.parse(JSON.stringify(store.get(k)));
          }
          return out;
        },
        set: async (objs: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(objs)) {
            store.set(k, JSON.parse(JSON.stringify(v)));
          }
        },
        remove: async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const k of keyList) store.delete(k);
        },
        clear: async () => store.clear(),
      },
    },
  };
  return { store };
}

function anchor(videoMs: number, subMs: number): DriftAnchor {
  return { videoMs, subMs, capturedAt: Date.now() };
}

describe("Drift correction storage", () => {
  let mgr: StorageManager;
  let store: Map<string, unknown>;

  beforeEach(() => {
    ({ store } = makeStorageMock());
    mgr = new StorageManager();
  });

  it("returns null for a missing record", async () => {
    expect(await mgr.getDriftRecord("track:xyz")).toBeNull();
  });

  it("saves and loads a record", async () => {
    const rec = { anchors: [anchor(1000, 2000)], model: null };
    await mgr.setDriftRecord("track:abc", rec);
    const loaded = await mgr.getDriftRecord("track:abc");
    expect(loaded).not.toBeNull();
    expect(loaded?.anchors?.length).toBe(1);
    expect(loaded?.anchors?.[0]?.videoMs).toBe(1000);
    expect(loaded?.updatedAt).toBeGreaterThan(0);
  });

  it("removes a single record", async () => {
    await mgr.setDriftRecord("a", { anchors: [anchor(0, 0)], model: null });
    await mgr.setDriftRecord("b", { anchors: [anchor(1, 1)], model: null });
    await mgr.removeDriftRecord("a");
    expect(await mgr.getDriftRecord("a")).toBeNull();
    expect(await mgr.getDriftRecord("b")).not.toBeNull();
  });

  it("prunes to the 50 most recent records", async () => {
    // Seed 55 records directly (bypassing setDriftRecord's pruning) to test
    // that the NEXT save prunes correctly
    const seed: Record<string, unknown> = {};
    for (let i = 0; i < 55; i++) {
      seed[`k${i}`] = { anchors: [], model: null, updatedAt: i };
    }
    store.set("driftCorrections", seed);

    // New record becomes the most recent; pruning keeps 50 newest:
    // 56 total → drop the 6 oldest seeds (k0..k5)
    await mgr.setDriftRecord("newest", { anchors: [], model: null });
    const after = (store.get("driftCorrections") || {}) as Record<string, unknown>;
    expect(Object.keys(after).length).toBe(50);
    expect(after["newest"]).toBeDefined();
    // Oldest seeds were pruned
    expect(after["k0"]).toBeUndefined();
    expect(after["k5"]).toBeUndefined();
    // Remaining seeds survive
    expect(after["k6"]).toBeDefined();
    expect(after["k54"]).toBeDefined();
  });

  it("clearAllDriftRecords removes everything", async () => {
    await mgr.setDriftRecord("a", { anchors: [], model: null });
    await mgr.clearAllDriftRecords();
    expect(await mgr.getDriftRecord("a")).toBeNull();
    expect(store.has("driftCorrections")).toBe(false);
  });

  it("corrupt/invalid storage shape does not throw", async () => {
    store.set("driftCorrections", "not-an-object");
    const loaded = await mgr.getDriftRecord("anything");
    expect(loaded).toBeNull();
    // And writing still works afterwards
    await mgr.setDriftRecord("a", { anchors: [], model: null });
    expect(await mgr.getDriftRecord("a")).not.toBeNull();
  });
});