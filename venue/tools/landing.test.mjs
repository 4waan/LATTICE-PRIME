import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
import {excess, G, permits, point, T} from "./lattice.mjs";

const source = readFileSync(new URL("./landing.mjs", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/landing.css", import.meta.url), "utf8");
const template = readFileSync(new URL("../app/index.template.html", import.meta.url), "utf8");

function classes() {
    const values = new Set();
    return {
        add: (...names) => names.forEach((name) => values.add(name)),
        remove: (...names) => names.forEach((name) => values.delete(name)),
        has: (name) => values.has(name),
        toggle: (name, force) => {
            const add = force === undefined ? !values.has(name) : force;
            if (add) values.add(name);
            else values.delete(name);
            return add;
        },
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

function fakeElement(document, {
    dataset = {},
    attributes = {},
    classNames = [],
    id = "",
    hidden = false,
} = {}) {
    const listeners = {};
    const element = {
        id,
        dataset,
        attributes: {...attributes},
        classList: classes(),
        hidden,
        disabled: false,
        tabIndex: -1,
        textContent: "",
        focused: false,
        isConnected: true,
        addEventListener(name, listener) {
            (listeners[name] ||= []).push(listener);
        },
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        getAttribute(name) {
            return this.attributes[name] ?? null;
        },
        focus() {
            this.focused = true;
            document.activeElement = this;
        },
        emit(name, supplied = {}) {
            const event = {
                key: "",
                defaultPrevented: false,
                preventDefault() {
                    this.defaultPrevented = true;
                },
                ...supplied,
            };
            for (const listener of listeners[name] || []) listener(event);
            return event;
        },
        listeners,
    };
    classNames.forEach((name) => element.classList.add(name));
    return element;
}

function makeSurface(document, kind) {
    const cells = [];
    for (let g = 0; g < 5; g++) {
        for (let t = 0; t < 6; t++) {
            cells.push(fakeElement(document, {
                dataset: {
                    g: String(g),
                    t: String(t),
                    membership: "none",
                    permitted: "false",
                },
            }));
        }
    }
    const matrix = fakeElement(document);
    const result = fakeElement(document);
    const resultExplanation = fakeElement(document);
    const ceiling = fakeElement(document);
    const actual = fakeElement(document);
    const resultLine = fakeElement(document, {hidden: kind === "landing"});
    const policyButtons = kind === "popup"
        ? ["aggregate", "exact-eod", "combined"].map((policy) =>
            fakeElement(document, {dataset: {latticePolicy: policy}}))
        : [];
    const policySlider = kind === "landing" ? fakeElement(document, {
        attributes: {"aria-valuetext": "Combined policy"},
    }) : null;
    if (policySlider) {
        policySlider.value = "2";
        policySlider.disabled = true;
    }
    const policyControl = kind === "landing" ? fakeElement(document, {
        dataset: {policy: "combined"},
        hidden: true,
    }) : null;
    const policyLabels = kind === "landing"
        ? ["aggregate", "exact-eod", "combined"].map((policy) =>
            fakeElement(document, {
                dataset: {
                    latticePolicyLabel: policy,
                    active: String(policy === "combined"),
                },
            }))
        : [];
    const root = fakeElement(document, {
        dataset: {
            latticeSurface: kind,
            policy: "combined",
            g: "2",
            t: "1",
            result: "inside",
        },
    });
    root.querySelectorAll = (selector) => ({
        "[data-lattice-policy]": policyButtons,
        "[data-lattice-cell]": cells,
        "[data-lattice-policy-label]": policyLabels,
    })[selector] || [];
    root.querySelector = (selector) => {
        if (selector === ".lattice-cell.is-selected") {
            return cells.find((cell) => cell.classList.has("is-selected")) || null;
        }
        return ({
            "[data-lattice-matrix]": matrix,
            "[data-lattice-result]": result,
            "[data-lattice-result-explanation]": resultExplanation,
            "[data-lattice-ceiling]": ceiling,
            "[data-lattice-actual]": actual,
            "[data-lattice-result-line]": resultLine,
            "[data-lattice-policy-slider]": policySlider,
            "[data-lattice-policy-control]": policyControl,
        })[selector] || null;
    };
    return {
        root,
        cells,
        matrix,
        result,
        resultExplanation,
        ceiling,
        actual,
        resultLine,
        policyButtons,
        policySlider,
        policyControl,
        policyLabels,
    };
}

function latticeHarness() {
    const document = {
        activeElement: null,
        documentElement: {classList: classes()},
    };
    const landing = makeSurface(document, "landing");
    const popup = makeSurface(document, "popup");
    const landingGrid = fakeElement(document);
    landingGrid.cloneNode = () => fakeElement(document);
    landing.root.querySelector = ((original) => (selector) =>
        selector === ".lattice-grid-layout" ? landingGrid : original(selector)
    )(landing.root.querySelector);

    const popupGrid = fakeElement(document);
    popupGrid.replaceChildren = (child) => {
        popupGrid.child = child;
    };
    const openButton = fakeElement(document, {hidden: true});
    const closeButton = fakeElement(document);
    const tabs = [
        fakeElement(document, {
            id: "lattice-tab-policy",
            attributes: {"aria-controls": "lattice-panel-policy", "aria-selected": "true"},
        }),
        fakeElement(document, {
            id: "lattice-tab-budget",
            attributes: {"aria-controls": "lattice-panel-budget", "aria-selected": "false"},
        }),
    ];
    tabs[0].tabIndex = 0;
    const panels = [
        fakeElement(document, {id: "lattice-panel-policy"}),
        fakeElement(document, {id: "lattice-panel-budget", hidden: true}),
    ];
    const dialog = fakeElement(document);
    dialog.open = false;
    dialog.showModal = () => {
        dialog.open = true;
    };
    dialog.close = () => {
        dialog.open = false;
        dialog.emit("close");
    };
    dialog.querySelectorAll = (selector) => ({
        '[role="tab"]': tabs,
        '[role="tabpanel"]': panels,
    })[selector] || [];
    dialog.querySelector = (selector) => ({
        '[data-lattice-surface="popup"]': popup.root,
        "[data-lattice-popup-grid]": popupGrid,
        "[data-lattice-close]": closeButton,
    })[selector] || null;

    document.querySelector = (selector) => ({
        '[data-lattice-surface="landing"]': landing.root,
        "[data-lattice-open]": openButton,
    })[selector] || null;
    document.getElementById = (id) => id === "lattice-dialog" ? dialog : null;

    const scrollCalls = [];
    const window = {
        scrollY: 320,
        scrollTo(x, y) {
            scrollCalls.push([x, y]);
            this.scrollY = y;
        },
    };
    const context = {document, window, excess, G, permits, point, T};
    runInNewContext(source + "\nthis.__Landing = Landing;", context);
    return {
        Landing: context.__Landing,
        document,
        window,
        landing,
        popup,
        popupGrid,
        openButton,
        closeButton,
        dialog,
        tabs,
        panels,
        scrollCalls,
    };
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
    assert.match(template, />Every disclosure changes what can be known\.<\/h2>/);
    assert.match(template, />What the venue withheld is verifiable\.<\/h2>/);
    assert.match(template, />Your next order starts here\.<\/h2>/);
    assert.doesNotMatch(template, /\bmixer\b/i);
    assert.doesNotMatch(template, /class="beat-src"/);
});

test("lattice explainer sits between the round and receipt sections", () => {
    const how = template.indexOf('id="how"');
    const lattice = template.indexOf('id="lattice"');
    const receipt = template.indexOf('id="receipt"');
    assert.ok(how >= 0 && how < lattice && lattice < receipt);
    assert.match(template, /A market print can reveal a summary now or exact detail later\./);
    assert.match(template, />Illustrative policy<\/p>/);
    assert.doesNotMatch(template, /timing and detail only/i);
    assert.match(template, />Print detail</);
    assert.match(template, />When it can be published</);
    assert.match(template, />Exact value</);
    assert.match(template, />Range</);
    assert.match(template, />Summary</);
    assert.match(template, />Yes\/no</);
    assert.match(template, />Venue publications only\. Underlying blockchain activity remains public\.</);
});

test("deep math and budgets appear only in the native dialog", () => {
    const section = template.slice(
        template.indexOf('<section class="frame lattice-frame"'),
        template.indexOf('<dialog class="lattice-dialog"'),
    );
    assert.match(template, /<dialog class="lattice-dialog"/);
    assert.match(template, />How the disclosure lattice works</);
    assert.match(template, /role="tab"[^>]*>Policy math</);
    assert.match(template, /role="tab"[^>]*>Publication budgets</);
    assert.doesNotMatch(section, /A = ↓|spent \+ cost|Contract representation|Model boundaries/);
    assert.match(template, /A = ↓\(aggregate, immediate\)/);
    assert.match(template, /spent \+ cost ≤ budget/);
});

test("landing uses one three-stop policy slider while popup keeps its buttons", () => {
    const section = template.slice(
        template.indexOf('<section class="frame lattice-frame"'),
        template.indexOf('<dialog class="lattice-dialog"'),
    );
    assert.match(section, /type="range" min="0" max="2" step="1" value="2" disabled data-lattice-policy-slider/);
    assert.match(section, />Aggregate now<\/span>/);
    assert.match(section, />Exact at EOD<\/span>/);
    assert.match(section, />Combined policy<\/span>/);
    assert.match(section, /lattice-swatch-aggregate"[^>]*><\/i>Aggregate now/);
    assert.match(section, /lattice-swatch-exact"[^>]*><\/i>Exact at EOD/);
    assert.match(section, /lattice-swatch-selection"[^>]*><\/i>Your selection/);
    assert.match(section, /lattice-swatch-forbidden"[^>]*><\/i>Outside policy/);
    assert.doesNotMatch(section, /<button[^>]+data-lattice-policy=/);
    assert.doesNotMatch(section, /<figcaption class="lattice-result"/);
    assert.equal((template.match(/<button[^>]+data-lattice-policy=/g) || []).length, 3);
});

test("no JavaScript leaves the combined policy and Summary now visible", () => {
    assert.match(
        template,
        /data-lattice-surface="landing" data-policy="combined" data-g="2" data-t="1" data-result="inside"/,
    );
    assert.match(template, /data-lattice-open hidden>Explore the math/);
    assert.match(template, /data-lattice-policy-control hidden/);
    assert.match(template, /class="lattice-live-result"[^>]+hidden>/);

    const a = point(G.AGG, T.IMM);
    const b = point(G.EXACT, T.EOD);
    const combined = (a | b) >>> 0;
    const actual = point(G.AGG, T.IMM);
    const over = excess(combined, actual);
    const cells = [...template.matchAll(
        /<button class="([^"]*\blattice-cell\b[^"]*)" type="button" disabled tabindex="-1" data-lattice-cell data-g="(\d)" data-t="(\d)" data-membership="([^"]+)" data-permitted="(true|false)"[^>]*aria-pressed="(true|false)"><\/button>/g,
    )];
    assert.equal(cells.length, 30);

    for (const [, className, gRaw, tRaw, membership, permitted, pressed] of cells) {
        const bit = (1 << (Number(gRaw) * 6 + Number(tRaw))) >>> 0;
        const inA = (a & bit) !== 0;
        const inB = (b & bit) !== 0;
        const expected = inA && inB ? "both" : inA ? "a" : inB ? "b" : "none";
        assert.equal(membership, expected, `membership at g=${gRaw}, t=${tRaw}`);
        assert.equal(permitted, String((combined & bit) !== 0));
        assert.equal(className.includes("is-implied"), (actual & bit) !== 0);
        assert.equal(className.includes("is-excess"), (over & bit) !== 0);
        const selected = Number(gRaw) === G.AGG && Number(tRaw) === T.IMM;
        assert.equal(className.includes("is-selected"), selected);
        assert.equal(pressed, String(selected));
    }
});

test("landing diamonds breathe asynchronously only when motion is allowed", () => {
    assert.match(css, /\[data-lattice-surface="landing"\] \.lattice-cell::after\{/);
    assert.match(css, /rotate\(45deg\);scale:1/);
    assert.match(css, /@keyframes lattice-diamond-breathe/);
    assert.match(css, /0%,100%\{scale:\.9\}/);
    assert.match(css, /50%\{scale:1\.08\}/);
    assert.match(css, /nth-of-type\(6n\+3\)::after/);
    assert.match(
        css,
        /@media\(prefers-reduced-motion:no-preference\)\{[\s\S]*animation:lattice-diamond-breathe/,
    );
    assert.match(css, /animation-play-state:paused;scale:1 !important/);
    assert.match(css, /:root\[data-theme="dark"\] \[data-lattice-surface="landing"\]/);
    assert.match(css, /--lattice-edge-purple:#3626b5/);
    assert.match(css, /--lattice-edge-yellow:#966300/);
    assert.match(css, /inset 0 -3px 0 var\(--lattice-edge-purple\)/);
    assert.match(css, /inset 3px 0 0 var\(--lattice-edge-yellow\)/);
    assert.match(css, /\.lattice-popup-grid \.lattice-cell\{background:var\(--surface\)\}/);
});

test("policy wire assigns green, yellow, and red stops from left to right", () => {
    assert.match(css, /--slider-green:#169b5f/);
    assert.match(css, /--slider-yellow:#d6a313/);
    assert.match(css, /--slider-red:#d84b4b/);
    assert.match(css, /\.lattice-slider-rail i:first-child\{[\s\S]*?background:var\(--slider-green\)/);
    assert.match(css, /\.lattice-slider-rail i:nth-child\(2\)\{[\s\S]*?background:var\(--slider-yellow\)/);
    assert.match(css, /\.lattice-slider-rail i:last-child\{[\s\S]*?background:var\(--slider-red\)/);
});

test("all 30 candidates use point, union, permits, and excess semantics", () => {
    const {Landing} = latticeHarness();
    const a = point(G.AGG, T.IMM);
    const b = point(G.EXACT, T.EOD);
    const policies = {
        aggregate: a,
        "exact-eod": b,
        combined: (a | b) >>> 0,
    };

    for (const [policyName, ceiling] of Object.entries(policies)) {
        for (let g = G.NONE; g <= G.EXACT; g++) {
            for (let t = T.PRE; t <= T.NEVER; t++) {
                const model = Landing.latticeModel(policyName, g, t);
                const actual = point(g, t);
                assert.equal(model.ceiling, ceiling, `${policyName} ceiling`);
                assert.equal(model.actual, actual, `${policyName} closure at ${g},${t}`);
                assert.equal(model.allowed, permits(ceiling, actual), `${policyName} permits ${g},${t}`);
                assert.equal(model.over, excess(ceiling, actual), `${policyName} excess ${g},${t}`);
            }
        }
    }

    assert.equal(Landing.latticeModel("combined", G.AGG, T.IMM).allowed, true);
    assert.equal(Landing.latticeModel("combined", G.EXACT, T.IMM).allowed, false);
    assert.equal(Landing.latticeModel("combined", G.EXACT, T.EOD).allowed, true);
});

test("renderer marks every policy, closure, selected cell, and forbidden bit", () => {
    const {Landing, popup} = latticeHarness();
    for (const policy of ["aggregate", "exact-eod", "combined"]) {
        for (let g = G.NONE; g <= G.EXACT; g++) {
            for (let t = T.PRE; t <= T.NEVER; t++) {
                const state = {policy, g, t};
                const model = Landing.renderLatticeSurface(popup.root, state);
                for (const cell of popup.cells) {
                    const cellG = Number(cell.dataset.g);
                    const cellT = Number(cell.dataset.t);
                    const bit = (1 << (cellG * 6 + cellT)) >>> 0;
                    assert.equal(
                        cell.dataset.permitted,
                        String((model.ceiling & bit) !== 0),
                        `${policy} permitted at ${g},${t} for ${cellG},${cellT}`,
                    );
                    assert.equal(cell.classList.has("is-implied"), (model.actual & bit) !== 0);
                    assert.equal(cell.classList.has("is-excess"), (model.over & bit) !== 0);
                    assert.equal(
                        cell.classList.has("is-selected"),
                        cellG === g && cellT === t,
                    );
                }
            }
        }
    }
});

test("landing slider maps all stops to exact policy membership", () => {
    const {Landing, landing} = latticeHarness();
    Landing.lattice();

    assert.equal(landing.policyControl.hidden, false);
    assert.equal(landing.policySlider.disabled, false);
    assert.equal(landing.resultLine.hidden, false);
    assert.equal(landing.policySlider.value, "2");
    assert.equal(landing.policySlider.attributes["aria-valuetext"], "Combined policy");
    assert.equal(landing.root.dataset.policy, "combined");
    assert.equal(landing.cells.filter((cell) => cell.dataset.permitted === "true").length, 21);

    landing.policySlider.value = "0";
    landing.policySlider.emit("input");
    assert.equal(landing.root.dataset.policy, "aggregate");
    assert.equal(landing.policyControl.dataset.policy, "aggregate");
    assert.equal(landing.policySlider.attributes["aria-valuetext"], "Aggregate now");
    assert.equal(landing.cells.filter((cell) => cell.dataset.permitted === "true").length, 15);
    assert.equal(landing.cells.filter((cell) => cell.classList.has("is-excess")).length, 0);
    assert.equal(landing.policyLabels[0].dataset.active, "true");

    landing.policySlider.value = "1";
    landing.policySlider.emit("input");
    assert.equal(landing.root.dataset.policy, "exact-eod");
    assert.equal(landing.policySlider.attributes["aria-valuetext"], "Exact at EOD");
    assert.equal(landing.cells.filter((cell) => cell.dataset.permitted === "true").length, 15);
    assert.equal(landing.cells.filter((cell) => cell.classList.has("is-excess")).length, 6);
    assert.equal(landing.policyLabels[1].dataset.active, "true");

    landing.policySlider.value = "2";
    landing.policySlider.emit("input");
    assert.equal(landing.root.dataset.policy, "combined");
    assert.equal(landing.policySlider.attributes["aria-valuetext"], "Combined policy");
    assert.equal(landing.cells.filter((cell) => cell.dataset.permitted === "true").length, 21);
    assert.equal(landing.cells.filter((cell) => cell.classList.has("is-excess")).length, 0);
    assert.equal(landing.policyLabels[2].dataset.active, "true");
    assert.equal(landing.root.dataset.g, String(G.AGG));
    assert.equal(landing.root.dataset.t, String(T.IMM));
});

test("landing grid uses roving focus and selects with Enter and Space", () => {
    const {
        Landing,
        landing,
        openButton,
    } = latticeHarness();
    Landing.lattice();

    const at = (g, t) => landing.cells.find((cell) =>
        Number(cell.dataset.g) === g && Number(cell.dataset.t) === t);
    const summaryNow = at(G.AGG, T.IMM);
    const rangeNow = at(G.BUCKET, T.IMM);
    assert.equal(openButton.hidden, false);
    assert.equal(landing.root.dataset.policy, "combined");
    assert.equal(landing.root.dataset.g, String(G.AGG));
    assert.equal(landing.root.dataset.t, String(T.IMM));
    assert.equal(summaryNow.tabIndex, 0);
    assert.equal(landing.cells.filter((cell) => cell.tabIndex === 0).length, 1);
    assert.ok(landing.cells.every((cell) => cell.disabled === false));

    summaryNow.emit("keydown", {key: "ArrowUp"});
    assert.equal(rangeNow.focused, true);
    assert.equal(rangeNow.tabIndex, 0);
    assert.equal(landing.root.dataset.g, String(G.AGG));

    rangeNow.emit("keydown", {key: "Enter"});
    assert.equal(landing.root.dataset.g, String(G.BUCKET));
    assert.equal(landing.root.dataset.t, String(T.IMM));
    assert.equal(landing.root.dataset.result, "outside");
    assert.equal(landing.result.textContent, "Outside policy");
    assert.equal(landing.resultExplanation.textContent, "Range detail is permitted from day close.");
    assert.equal(landing.cells.filter((cell) => cell.classList.has("is-implied")).length, 20);
    assert.equal(landing.cells.filter((cell) => cell.classList.has("is-excess")).length, 2);

    const rangeM15 = at(G.BUCKET, T.M15);
    rangeNow.emit("keydown", {key: "ArrowRight"});
    rangeM15.emit("keydown", {key: " "});
    assert.equal(landing.root.dataset.t, String(T.M15));

    at(G.EXACT, T.IMM).emit("click");
    assert.equal(landing.root.dataset.result, "outside");
    assert.equal(landing.cells.filter((cell) => cell.classList.has("is-excess")).length, 4);
    at(G.EXACT, T.EOD).emit("click");
    assert.equal(landing.root.dataset.result, "inside");
});

test("None and Never explain model meaning without scheduling claims", () => {
    const {Landing, landing} = latticeHarness();
    Landing.lattice();
    const at = (g, t) => landing.cells.find((cell) =>
        Number(cell.dataset.g) === g && Number(cell.dataset.t) === t);

    at(G.NONE, T.IMM).emit("click");
    assert.match(landing.resultExplanation.textContent, /no-detail level/);
    assert.doesNotMatch(landing.resultExplanation.textContent, /scheduled/i);

    at(G.EXACT, T.NEVER).emit("click");
    assert.match(landing.resultExplanation.textContent, /does not publish/);
    assert.doesNotMatch(landing.resultExplanation.textContent, /scheduled/i);
});

test("dialog initializes from landing and keeps popup state isolated", () => {
    const {
        Landing,
        document,
        landing,
        popup,
        popupGrid,
        openButton,
        closeButton,
        dialog,
        scrollCalls,
    } = latticeHarness();
    Landing.lattice();
    const landingAt = (g, t) => landing.cells.find((cell) =>
        Number(cell.dataset.g) === g && Number(cell.dataset.t) === t);
    const popupAt = (g, t) => popup.cells.find((cell) =>
        Number(cell.dataset.g) === g && Number(cell.dataset.t) === t);

    landing.policySlider.value = "0";
    landing.policySlider.emit("input");
    landingAt(G.EXACT, T.EOD).emit("click");
    openButton.focus();
    openButton.emit("click");
    assert.equal(dialog.open, true);
    assert.ok(popupGrid.child);
    assert.equal(document.documentElement.classList.has("lattice-dialog-open"), true);
    assert.equal(popup.root.dataset.policy, "combined");
    assert.equal(popup.root.dataset.g, String(G.EXACT));
    assert.equal(popup.root.dataset.t, String(T.EOD));
    assert.equal(popup.result.textContent, "Within policy");
    assert.equal(popup.ceiling.textContent, "ceiling = A ∪ B");

    popup.policyButtons[0].emit("click");
    popupAt(G.BUCKET, T.IMM).emit("click");
    assert.equal(popup.root.dataset.policy, "aggregate");
    assert.equal(popup.root.dataset.g, String(G.BUCKET));
    assert.equal(landing.root.dataset.policy, "aggregate");
    assert.equal(landing.root.dataset.g, String(G.EXACT));
    assert.equal(landing.root.dataset.t, String(T.EOD));

    closeButton.emit("click");
    assert.equal(dialog.open, false);
    assert.equal(document.documentElement.classList.has("lattice-dialog-open"), false);
    assert.equal(openButton.focused, true);
    assert.deepEqual(scrollCalls.at(-1), [0, 320]);

    openButton.emit("click");
    assert.equal(popup.root.dataset.policy, "combined");
    assert.equal(popup.root.dataset.g, String(G.EXACT));
    assert.equal(popup.root.dataset.t, String(T.EOD));
    const cancel = dialog.emit("cancel");
    assert.equal(cancel.defaultPrevented, true);
    assert.equal(dialog.open, false);
});

test("dialog tabs implement selected state and arrow-key navigation", () => {
    const {Landing, openButton, tabs, panels} = latticeHarness();
    Landing.lattice();
    openButton.emit("click");

    assert.equal(tabs[0].attributes["aria-selected"], "true");
    assert.equal(panels[0].hidden, false);
    assert.equal(panels[1].hidden, true);

    tabs[0].emit("keydown", {key: "ArrowRight"});
    assert.equal(tabs[1].attributes["aria-selected"], "true");
    assert.equal(tabs[1].focused, true);
    assert.equal(panels[0].hidden, true);
    assert.equal(panels[1].hidden, false);

    tabs[1].emit("keydown", {key: "Home"});
    assert.equal(tabs[0].attributes["aria-selected"], "true");
    assert.equal(tabs[0].focused, true);
    assert.equal(panels[0].hidden, false);
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
