import template from "../flora.ts";

// The primary nav carries a "you are here" marker (chrome-status-lite-whe):
// the link matching the current path gains class="current" plus
// aria-current="page", mirroring the version chips' marker, so the cue is both
// visual and programmatic (WCAG 1.3.1). /wiki matches its topic pages by
// prefix; "/" matches exactly so deep feature pages do not light up Home.
// Paths with no nav link (feature pages, feature history/diff) mark nothing.
const LINKS: Array<[string, string]> = [
  ["/", "Home"],
  ["/diff", "Compare releases"],
  ["/breaking", "Breaking Changes"],
  ["/origin-trials", "Origin Trials"],
  ["/deprecations", "Deprecation Calendar"],
  ["/wiki", "Topic Wiki"],
  ["/feed.xml", "RSS"],
];

function isCurrent(href: string, currentPath: string): boolean {
  return href === "/"
    ? currentPath === "/"
    : currentPath === href || currentPath.startsWith(`${href}/`);
}

export default function render(currentPath = "") {
  // The skip link is the first body element on every page (each shell renders
  // nav() immediately after <body>), letting keyboard users bypass the 7-link
  // nav (WCAG 2.4.1). Its target is each shell's <main id="main">.
  return template`<a class="skip" href="#main">Skip to content</a><nav>
    <ul>
      ${
    LINKS.map(([href, label]) =>
      template`<li><a href="${href}"${
        isCurrent(href, currentPath) ? template` class="current" aria-current="page"` : template``
      }>${label}</a></li>`
    )
  }
    </ul>
  </nav>`;
}
