import template from "../flora.ts";

export default function render(request: Request): Response {
  const url = new URL(request.url);
  const version = url.searchParams.get("version") || 106;
  return template`
  <!doctype html>
<html>

<head>
  <script src="/scripts/index.js" type="module"></script>
  <title>Chrome Release ${version}</title>
  <link rel="stylesheet" href="/styles/index.css">
</head>

<body>
  <h1>Create the release blog</h1>
  <label for="version">Chrome version</label>

  <select name="version" id="version">
    <option>Pick a version</option>
  </select>
  <div id="output"></div>
</body>

</html>`
    .then(data => new Response(data, { status: 200, headers: { 'content-type': 'text/html' } }));
};