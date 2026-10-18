import template from "../flora.ts";

export default function render() {
  return template`<nav>
    <ul>
      <li><a href="/">Home</a></li>
      <li><a href="/diff">Compare releases</a></li>
      <li><a href="/breaking">Breaking Changes</a></li>
      <li><a href="/origin-trials">Origin Trials</a></li>
      <li><a href="/deprecations">Deprecation Calendar</a></li>
      <li><a href="/feed.xml">RSS</a></li>
    </ul>
  </nav>`;
}
