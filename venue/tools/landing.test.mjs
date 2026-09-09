import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";

const source = readFileSync(new URL("./landing.mjs", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/landing.css", import.meta.url), "utf8");
const template = readFileSync(new URL("../app/index.template.html", import.meta.url), "utf8");

function classes() {
    const values = new Set();
    return {
        add: (...names) => names.forEach((name) => values.add(name)),
        has: (name) => values.has(name),
    };
}

function revealHarness({reduced = false, observer = false} = {}) {
    const items = [{classList: classes()}, {classList: classes()}];
    const rootClasses = classes();
    const document = {
        querySelectorAll: () => items,
        documentElement: {classList: rootClasses},
    };
    const window = {
        matchMedia: () => ({matches: reduced}),
    };
    const context = {document, window};
    if (observer) {
        class IntersectionObserver {
            observe() {}
            unobserve() {}
        }
        context.IntersectionObserver = IntersectionObserver;
        window.IntersectionObserver = IntersectionObserver;
    }
    runInNewContext(source + "\nthis.__Landing = Landing;", context);
    return {Landing: context.__Landing, items, rootClasses};
}

test("no JavaScript leaves reveal content visible", () => {
    assert.match(css, /\.motion-ready \.rise\{opacity:0/);
    assert.match(css, /\.motion-ready \.pop\{opacity:0/);
    assert.doesNotMatch(css, /\n\s*\.rise\{opacity:0/);
    assert.doesNotMatch(css, /\n\s*\.pop\{opacity:0/);
});

test("interactive activity cards remain readable in every phase", () => {
    assert.doesNotMatch(
        css,
        /\.propagation\.is-interactive \.audience-grid\s*\{[^}]*opacity\s*:/s,
    );
    assert.match(
        css,
        /\.propagation\.is-interactive\[data-phase="publish"\] \.audience-grid article\{/,
    );
});

test("landing journey uses trader-facing copy", () => {
    assert.match(template, />Prove, seal, account, verify\.<\/h2>/);
    assert.match(template, />Privacy is a scale, not a toggle<\/h2>/);
    assert.match(template, />Your next order starts here\.<\/h2>/);
    assert.doesNotMatch(template, /\bmixer\b/i);
    assert.doesNotMatch(template, /class="beat-src"/);
});

test("reduced motion reveals everything without arming transitions", () => {
    const {Landing, items, rootClasses} = revealHarness({reduced: true});
    Landing.reveals();
    assert.ok(items.every((item) => item.classList.has("in")));
    assert.equal(rootClasses.has("motion-ready"), false);
});

test("motion is armed only after observers exist", () => {
    const {Landing, items, rootClasses} = revealHarness({observer: true});
    Landing.reveals();
    assert.ok(items.every((item) => !item.classList.has("in")));
    assert.equal(rootClasses.has("motion-ready"), true);
});
