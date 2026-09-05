// Builds `docs/disclosure-receipt.html` from the template plus the module the
// vector suite checks. Generated, never hand edited, for the same reason
// `gen-preview.mjs` is: the page claims to print the budget the contract
// charges, and a page carrying its own private copy of the arithmetic cannot
// make that claim.
import {build} from "./gen-page.mjs";

build("docs/receipt.template.html", "docs/disclosure-receipt.html");
