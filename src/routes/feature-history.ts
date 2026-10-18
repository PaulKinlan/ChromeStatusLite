import template from "../flora.ts";
import type { StatusClient } from "../handler.ts";
import { escapeHtml } from "https://deno.land/x/escape_html/mod.ts";
import {
  diffSnapshots,
  type FeatureSnapshot,
  type SnapshotStore,
} from "../lib/snapshots.ts";
import nav from "../ui-components/nav.ts";

const page = (title: string, content) =>
  template`
  <!doctype html>
<html>

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Chrome Platform Status</title>
  <link rel="stylesheet" href="/styles/index.css">
</head>

<body>
  ${nav()}
  <div id="output">
  ${content}
  </div>
</body>

</html>`;

const respond = (data, status = 200) =>
  new Response(data, { status, headers: { "content-type": "text/html" } });

const fieldChanges = (from?: FeatureSnapshot, to?: FeatureSnapshot) => {
  if (!from || !to) return [];
  return diffSnapshots(from, to).map((d) => d.field);
};

export async function renderHistory(
  _request: Request,
  match: URLPatternResult,
  _chromeStatusAPI: StatusClient,
  store: SnapshotStore | null,
): Promise<Response> {
  const id = match?.pathname?.groups?.id;
  if (!id || /\D/.test(id)) {
    return new Response("Not found", { status: 404 });
  }
  if (!store) {
    return page(
      `Feature ${id} history`,
      template`<p><a href="/feature/${id}">&larr; Back to feature</a></p>
      <h1>Feature history</h1>
      <p class="error-notice">Snapshot history is not configured on this deployment.</p>`,
    ).then((data) => respond(data));
  }

  let snapshots: FeatureSnapshot[];
  try {
    snapshots = await store.list(id);
  } catch {
    // A broken store must not look like "no history yet".
    return page(
      `Feature ${id} history`,
      template`<p><a href="/feature/${id}">&larr; Back to feature</a></p>
      <h1>Feature history</h1>
      <p class="error-notice">Snapshot history is temporarily unavailable. Please try again later.</p>`,
    ).then((data) => respond(data));
  }
  const name = snapshots[0]?.data["Name"] ?? `Feature ${id}`;

  if (snapshots.length === 0) {
    return page(
      `Feature ${id} history`,
      template`<p><a href="/feature/${id}">&larr; Back to feature</a></p>
      <h1>${escapeHtml(name)}: history</h1>
      <p>No snapshots captured yet. History builds up as readers view this
      feature; check back after the feature's details change.</p>`,
    ).then((data) => respond(data));
  }

  // Cap the page: a heavily-viewed feature must not render an ever-growing list.
  const MAX_ENTRIES = 25;
  const shown = snapshots.slice(0, MAX_ENTRIES);
  const older = snapshots.length - shown.length;
  const entries = snapshots.map((snap, i) => {
    const older = snapshots[i + 1];
    const changed = fieldChanges(older, snap);
    const diffHref = older
      ? template`<a href="/feature/${id}/diff?from=${older.at}&to=${snap.at}">diff ${older.at.slice(0, 10)} → ${snap.at.slice(0, 10)}</a>`
      : template`first capture`;
    return template`<li>
      <strong>${snap.at.replace("T", " ").slice(0, 16)}Z</strong> — ${diffHref}
      ${
        changed.length
          ? template`<br>changed: ${escapeHtml(changed.join(", "))}`
          : ""
      }
    </li>`;
  });

  return page(
    `${name} history`,
    template`<p><a href="/feature/${id}">&larr; Back to feature</a></p>
    <h1>${escapeHtml(name)}: history</h1>
    <p>${snapshots.length} snapshot(s), newest first. Every capture records the
    tracked fields as they were when a reader viewed the feature.</p>
    <ul class="snapshot-history">${shown.map((_, i) => entries[i])}</ul>
    ${older > 0 ? template`<p>${older} older capture(s) not shown.</p>` : template``}`,
  ).then((data) => respond(data));
}

export async function renderDiff(
  request: Request,
  match: URLPatternResult,
  _chromeStatusAPI: StatusClient,
  store: SnapshotStore | null,
): Promise<Response> {
  const id = match?.pathname?.groups?.id;
  if (!id || /\D/.test(id)) {
    return new Response("Not found", { status: 404 });
  }
  if (!store) {
    return page(
      `Feature ${id} diff`,
      template`<p><a href="/feature/${id}">&larr; Back to feature</a></p>
      <h1>Feature diff</h1>
      <p class="error-notice">Snapshot history is not configured on this deployment.</p>`,
    ).then((data) => respond(data));
  }

  let snapshots: FeatureSnapshot[];
  try {
    snapshots = await store.list(id);
  } catch {
    return page(
      `Feature ${id} diff`,
      template`<p><a href="/feature/${id}">&larr; Back to feature</a></p>
      <h1>Feature diff</h1>
      <p class="error-notice">Snapshot history is temporarily unavailable. Please try again later.</p>`,
    ).then((data) => respond(data));
  }
  const name = snapshots[0]?.data["Name"] ?? `Feature ${id}`;
  const url = new URL(request.url);
  const fromAt = url.searchParams.get("from");
  const toAt = url.searchParams.get("to");
  let from = (fromAt && snapshots.find((s) => s.at === fromAt)) ??
    snapshots[snapshots.length - 1];
  let to = (toAt && snapshots.find((s) => s.at === toAt)) ?? snapshots[0];
  let paramNotice = template``;
  if (fromAt && !snapshots.some((s) => s.at === fromAt) ||
      toAt && !snapshots.some((s) => s.at === toAt)) {
    paramNotice = template`<p class="error-notice">The requested snapshot pair was not found; showing oldest &rarr; newest instead.</p>`;
  }
  // Always diff older -> newer: a swapped URL must not present the live
  // state as removed and the past as added.
  if (from && to && from.at > to.at) [from, to] = [to, from];

  if (!from || !to || from === to) {
    return page(
      `${name} diff`,
      template`<p><a href="/feature/${id}/history">&larr; Back to history</a></p>
      <h1>${escapeHtml(name)}: diff</h1>
      <p>Two different snapshots are needed for a diff. <a href="/feature/${id}/history">View the history</a> to pick a pair.</p>`,
    ).then((data) => respond(data));
  }

  const diffs = diffSnapshots(from, to);
  const rows = diffs.length
    ? diffs.map((d) => {
      const label = template`<div class="diff-field">${escapeHtml(d.field)}</div>`;
      if (d.kind === "added") {
        return template`<div class="diff-block">${label}
          <div class="diff-line diff-add">+ ${escapeHtml(d.to)}</div></div>`;
      }
      if (d.kind === "removed") {
        return template`<div class="diff-block">${label}
          <div class="diff-line diff-del">− ${escapeHtml(d.from)}</div></div>`;
      }
      return template`<div class="diff-block">${label}
        <div class="diff-line diff-del">− ${escapeHtml(d.from)}</div>
        <div class="diff-line diff-add">+ ${escapeHtml(d.to)}</div></div>`;
    })
    : template`<p>No tracked field changed between these snapshots.</p>`;

  return page(
    `${name} diff`,
    template`<p><a href="/feature/${id}/history">&larr; Back to history</a></p>
    <h1>${escapeHtml(name)}: diff</h1>
    ${paramNotice}
    <p>${from.at.replace("T", " ").slice(0, 16)}Z → ${to.at.replace("T", " ").slice(0, 16)}Z</p>
    <div class="diff">${rows}</div>`,
  ).then((data) => respond(data));
}
