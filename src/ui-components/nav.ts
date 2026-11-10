import template from "../flora.ts";

export default function render() {
  // The skip link is the first body element on every page (each shell renders
  // nav() immediately after <body>), letting keyboard users bypass the 7-link
  // nav (WCAG 2.4.1). Its target is each shell's <main id="main">.
  return template`<a class="skip" href="#main">Skip to content</a><nav>
    <ul>
      <li><a href="/">Home</a></li>
      <li><a href="/diff">Compare releases</a></li>
      <li><a href="/breaking">Breaking Changes</a></li>
      <li><a href="/origin-trials">Origin Trials</a></li>
      <li><a href="/deprecations">Deprecation Calendar</a></li>
      <li><a href="/wiki">Topic Wiki</a></li>
      <li><a href="/feed.xml">RSS</a></li>
    </ul>
  </nav>`;
}
