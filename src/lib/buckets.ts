// The v0 API groups a milestone's features by status text ("buckets").
// One validator shared by every route that consumes that shape, so the
// pages can never disagree about what counts as real data (a divergence
// here is how /feed.xml ended up claiming "0 feature changes" for a
// malformed payload that / correctly rejected as an upstream error).
export const BUCKET_KEYS = [
  "Enabled by default",
  "Origin trial",
  "In developer trial (Behind a flag)",
  "Removed",
  "Deprecated",
] as const;

const isValidFeatureObject = (item: any): boolean =>
  Boolean(item && typeof item === "object" && !Array.isArray(item));

// A payload is real data when every recognised bucket key that is present
// holds an array of feature objects, and at least one recognised key is
// present. A milestone with no features is real data too: the API returns
// every bucket as an empty array (total_count 0), which stays valid.
export const hasValidBuckets = (obj: any): boolean => {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  let foundAnyBucket = false;
  for (const k of BUCKET_KEYS) {
    if (k in obj) {
      if (!Array.isArray(obj[k])) return false;
      if (!obj[k].every(isValidFeatureObject)) return false;
      foundAnyBucket = true;
    }
  }
  return foundAnyBucket;
};
