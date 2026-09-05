// Builds `docs/commit-preview.html` from the template plus the modules the vector
// suite checks. Generated, never hand edited: the page claims to show the
// commitment the contract will re-hash, and a page carrying its own private copy
// of keccak cannot make that claim.
import {build} from "./gen-page.mjs";

build("docs/commit-preview.template.html", "docs/commit-preview.html");
