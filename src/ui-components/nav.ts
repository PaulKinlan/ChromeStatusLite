import template from "../flora.ts";

export default function render() {
  return template`<nav>
    <ul><li><a href="/">Home</a></li><li><a href="/deprecations">Deprecation Calendar</a></li></ul>
  </nav>`;
};