import { test } from "vitest";
import template, { raw } from "../src/flora.ts";
import { equal } from "./fixture.ts";

const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
  new Response(stream).text();

test("flora stream converts mid-stream rejections into stream errors without unhandled rejection", async () => {
  const stream = await template`<div>${(async () => {
    throw new Error("mid-stream failure");
  })()}</div>`;
  let streamFailed = false;
  try {
    const reader = stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch (err: any) {
    if (err.message === "mid-stream failure") {
      streamFailed = true;
    }
  }
  equal(streamFailed, true);
});

test("flora escapes interpolated strings by default (chrome-status-lite-btw)", async () => {
  const html = await drain(
    await template`<p>${"<img src=x onerror=alert(1)>"}</p>`,
  );
  equal(html, "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
});

test("flora escapes strings inside arrays and promises too", async () => {
  const html = await drain(
    await template`<ul>${[
      "<b>one</b>",
      Promise.resolve("<i>two</i>"),
    ]}</ul>`,
  );
  equal(html, "<ul>&lt;b&gt;one&lt;/b&gt;&lt;i&gt;two&lt;/i&gt;</ul>");
});

test("flora emits raw() values verbatim and passes nested templates through as markup", async () => {
  const html = await drain(await template`<div>${raw("<em>ok</em>")}</div>`);
  equal(html, "<div><em>ok</em></div>");

  const inner = template`<b>${"<i>inner</i>"}</b>`;
  const outer = await drain(await template`<div>${inner}</div>`);
  equal(outer, "<div><b>&lt;i&gt;inner&lt;/i&gt;</b></div>");
});

test("flora interpolates numbers and null/undefined without escaping artifacts", async () => {
  const html = await drain(
    await template`<p>${42}:${null}:${undefined}</p>`,
  );
  equal(html, "<p>42::</p>");
});

test("flora escapes object leaves with a custom toString (chrome-status-lite-d9n)", async () => {
  const hostile = { toString: () => "<script>alert(1)</script>" };
  const html = await drain(await template`<p>${hostile}</p>`);
  equal(html, "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  const wrapped = await drain(await template`<p>${new String("<b>x</b>")}</p>`);
  equal(wrapped, "<p>&lt;b&gt;x&lt;/b&gt;</p>");
  const plain = await drain(await template`<p>${120}:${true}</p>`);
  equal(plain, "<p>120:true</p>");
});
