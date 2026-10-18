import type { StatusClient } from "../src/handler.ts";

export const sampleFeature = {
  id: 123, name: "Fixture feature", summary: "A fixture summary", motivation: "Useful fixture",
  breaking_change: true, enterprise_impact: 3, flag_name: "fixture-flag", wpt: true,
  standards: { maturity: { short_text: "Working draft" } },
  resources: { docs: [], samples: [] }, browsers: { chrome: { status: { text: "Enabled by default", milestone_str: "120" } } },
};

export function fixtureClient(overrides: Partial<StatusClient> = {}): StatusClient {
  return {
    getVersions: async () => [120, 119, 118, 117, 116, 115, 114, 113, 112, 111],
    getFeaturesForVersion: async () => ({ "Enabled by default": [sampleFeature] }),
    getFeaturesByType: async () => ({ features: [
      { id: 123, name: "Deprecated fixture", intent_stage: "Intent to Deprecate", browsers: { chrome: { desktop: "120" } } },
    ] }),
    getChannels: async (start?: number, end?: number) => {
      if (start === undefined && end === undefined) {
        return { dev: { version: "120" }, stable: { version: "118" } };
      }
      return { "120": { stable_date: "2024-01-01T00:00:00Z" } };
    },
    getFeature: async () => sampleFeature,
    getFeaturesByQuery: async () => ({ total_count: 1, features: [sampleFeature] }),
    ...overrides,
  };
}

export function equal<T>(actual: T, expected: T): void {
  if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
export function includes(value: string, fragment: string): void {
  if (!value.includes(fragment)) throw new Error(`Missing ${JSON.stringify(fragment)}`);
}
