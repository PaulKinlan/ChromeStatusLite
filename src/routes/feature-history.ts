import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import {
  diffSnapshots,
  type FeatureSnapshot,
  type SnapshotStore,
} from "../lib/snapshots.ts";
import { isValidFeatureId } from "../lib/utils.ts";
import {
  HISTORY_CACHE_CONTROL,
  htmlResponse,
  NO_STORE_CACHE_CONTROL,
} from "../ui-components/layout.ts";

const pageResponse = (
  title: string,
  content: unknown,
  canonical: string,
  cacheControl = HISTORY_CACHE_CONTROL,
) =>
  htmlResponse({
    title: `${title} — Chrome Platform Status`,
    canonical,
    cacheControl,
    // No nav link matches /feature/:id/history or /feature/:id/diff.
    currentPath: "",
    body: template`<div id="output">${content}</div>`,
  });

const fieldChanges = (from?: FeatureSnapshot, to?: FeatureSnapshot): string[] => {
  if (!from || !to) return [];
  return diffSnapshots(from, to).map((d) => d.field);
};

export async function renderHistory(
  request: Request,
  match: URLPatternResult,
  _chromeStatusAPI: StatusClient,
  store: SnapshotStore | null,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const id = match?.pathname?.groups?.id;
  if (!isValidFeatureId(id)) {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": NO_STORE_CACHE_CONTROL },
    });
  }
  const canonicalUrl = new URL(request.url);
  const canonical = `https://chromestatuslite.com${
    canonicalUrl.pathname + canonicalUrl.search
  }`;
  if (!store) {
    return pageResponse(
      `Feature ${id} history`,
      template`<p><a href="/feature/${id}">&larr; Back to feature</a></p>
      <h1>Feature history</h1>
      <p class="error-notice">Snapshot history is not configured on this deployment.</p>`,
      canonical,
      NO_STORE_CACHE_CONTROL,
    );
  }

  let snapshots: FeatureSnapshot[];
  try {
    snapshots = await store.list(id);
  } catch {
    return pageResponse(
      `Feature ${id} history`,
      template`<p><a href="/feature/${id}">&larr; Back to feature</a></p>
      <h1>Feature history</h1>
      <p class="error-notice">Snapshot history is temporarily unavailable. Please try again later.</p>`,
      canonical,
      NO_STORE_CACHE_CONTROL,
    );
  }
  if (request.method !== "HEAD" && store.touch) {
    const touch = store.touch(id).catch(() => {});
    if (waitUntil) waitUntil(touch);
    else await touch;
  }
  const name = snapshots[0]?.data["Name"] ?? `Feature ${id}`;

  if (snapshots.length === 0) {
    return pageResponse(
      `Feature ${id} history`,
      template`<p><a href="/feature/${id}">&larr; Back to feature</a></p>
      <h1>${name}: history</h1>
      <p>No snapshots captured yet. History builds up as readers view this
      feature; check back after the feature's details change.</p>`,
      canonical,
    );
  }

  // Cap the page and only compute diffs for the shown entries.
  const MAX_ENTRIES = 25;
  const shown = snapshots.slice(0, MAX_ENTRIES);
  const withheld = snapshots.length - shown.length;
  const entries = shown.map((snap, i) => {
    const prev = snapshots[i + 1];
    const changed = fieldChanges(prev, snap);
    const diffHref = prev
      ? template`<a href="/feature/${id}/diff?from=${
        encodeURIComponent(prev.at)
      }&amp;to=${encodeURIComponent(snap.at)}">diff ${
        prev.at.slice(0, 10)
      } → ${snap.at.slice(0, 10)}</a>`
      : template`first capture`;
    return template`<li>
      <strong>${snap.at.replace("T", " ").slice(0, 16)}Z</strong> — ${diffHref}
      ${
      changed.length ? template`<br>changed: ${changed.join(", ")}` : ""
    }
    </li>`;
  });

  return pageResponse(
    `${name} history`,
    template`<p><a href="/feature/${id}">&larr; Back to feature</a></p>
    <h1>${name}: history</h1>
    <p>${snapshots.length} snapshot(s), newest first. Every capture records the
    tracked fields as they were when a reader viewed the feature.</p>
    <ul class="snapshot-history">${entries}</ul>
    ${
      withheld > 0
        ? template`<p>${withheld} older capture(s) not shown.</p>`
        : template``
    }`,
    canonical,
  );
}

export async function renderDiff(
  request: Request,
  match: URLPatternResult,
  _chromeStatusAPI: StatusClient,
  store: SnapshotStore | null,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const id = match?.pathname?.groups?.id;
  if (!isValidFeatureId(id)) {
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": NO_STORE_CACHE_CONTROL },
    });
  }
  const url = new URL(request.url);
  const canonical = `https://chromestatuslite.com${
    url.pathname + url.search
  }`;
  if (!store) {
    return pageResponse(
      `Feature ${id} diff`,
      template`<p><a href="/feature/${id}">&larr; Back to feature</a></p>
      <h1>Feature diff</h1>
      <p class="error-notice">Snapshot history is not configured on this deployment.</p>`,
      canonical,
      NO_STORE_CACHE_CONTROL,
    );
  }

  let snapshots: FeatureSnapshot[];
  try {
    snapshots = await store.list(id);
  } catch {
    return pageResponse(
      `Feature ${id} diff`,
      template`<p><a href="/feature/${id}">&larr; Back to feature</a></p>
      <h1>Feature diff</h1>
      <p class="error-notice">Snapshot history is temporarily unavailable. Please try again later.</p>`,
      canonical,
      NO_STORE_CACHE_CONTROL,
    );
  }
  if (request.method !== "HEAD" && store.touch) {
    const touch = store.touch(id).catch(() => {});
    if (waitUntil) waitUntil(touch);
    else await touch;
  }
  const name = snapshots[0]?.data["Name"] ?? `Feature ${id}`;
  const fromAt = url.searchParams.get("from");
  const toAt = url.searchParams.get("to");
  let from = (fromAt && snapshots.find((s) => s.at === fromAt)) ??
    snapshots[snapshots.length - 1];
  let to = (toAt && snapshots.find((s) => s.at === toAt)) ?? snapshots[0];
  let paramNotice = template``;
  if (
    (fromAt && !snapshots.some((s) => s.at === fromAt)) ||
    (toAt && !snapshots.some((s) => s.at === toAt))
  ) {
    paramNotice =
      template`<p class="error-notice">The requested snapshot pair was not found; showing oldest &rarr; newest instead.</p>`;
  }
  if (from && to && from.at > to.at) [from, to] = [to, from];

  if (!from || !to || from === to) {
    return pageResponse(
      `${name} diff`,
      template`<p><a href="/feature/${id}/history">&larr; Back to history</a></p>
      <h1>${name}: diff</h1>
      <p>Two different snapshots are needed for a diff. <a href="/feature/${id}/history">View the history</a> to pick a pair.</p>`,
      canonical,
    );
  }

  const diffs = diffSnapshots(from, to);
  const rows = diffs.length
    ? diffs.map((d) => {
      const label = template`<div class="diff-field">${d.field}</div>`;
      if (d.kind === "added") {
        return template`<div class="diff-block">${label}
          <div class="diff-line diff-add">+ ${d.to}</div></div>`;
      }
      if (d.kind === "removed") {
        return template`<div class="diff-block">${label}
          <div class="diff-line diff-del">− ${d.from}</div></div>`;
      }
      return template`<div class="diff-block">${label}
        <div class="diff-line diff-del">− ${d.from}</div>
        <div class="diff-line diff-add">+ ${d.to}</div></div>`;
    })
    : template`<p>No tracked field changed between these snapshots.</p>`;

  return pageResponse(
    `${name} diff`,
    template`<p><a href="/feature/${id}/history">&larr; Back to history</a></p>
    <h1>${name}: diff</h1>
    ${paramNotice}
    <p>${from.at.replace("T", " ").slice(0, 16)}Z → ${
      to.at.replace("T", " ").slice(0, 16)
    }Z</p>
    <div class="diff">${rows}</div>`,
    canonical,
  );
}
