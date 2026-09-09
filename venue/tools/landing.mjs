// Front-door behaviour: the light that follows the cursor, the scroll
// invitation, and the staggered reveals.
//
// No dependencies and no imports, because `tools/gen-page.mjs` inlines this
// file into `app/index.html` verbatim. Every effect here is decoration:
// the page is complete and readable with this script absent, and everything is
// switched off under `prefers-reduced-motion`.

const Landing = {};

Landing.reduced = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- the light ----------
//
// The pointer sets a target; a frame loop walks the rendered position toward it
// a fraction at a time. That fraction is what makes it flow rather than jump:
// a fast flick leaves the glow trailing and catching up. The loop parks itself
// once the two agree, so an idle tab costs nothing.
Landing.aura = function () {
    const el = document.getElementById("aura");
    if (!el || Landing.reduced()) return;
    if (window.matchMedia("(hover: none)").matches) return;

    let tx = window.innerWidth * 0.5;
    let ty = window.innerHeight * 0.34;
    let x = tx;
    let y = ty;
    let running = false;

    const paint = () => {
        el.style.setProperty("--mx", x.toFixed(1) + "px");
        el.style.setProperty("--my", y.toFixed(1) + "px");
    };

    const step = () => {
        const dx = tx - x;
        const dy = ty - y;
        // Under a third of a pixel apart is under a device pixel. Stop.
        if (Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3) {
            x = tx;
            y = ty;
            paint();
            running = false;
            return;
        }
        x += dx * 0.11;
        y += dy * 0.11;
        paint();
        requestAnimationFrame(step);
    };

    const wake = () => {
        if (running) return;
        running = true;
        requestAnimationFrame(step);
    };

    paint();
    window.addEventListener("pointermove", (e) => {
        if (e.pointerType === "touch") return;
        tx = e.clientX;
        ty = e.clientY;
        wake();
    }, {passive: true});

    // Leaving the window pulls the light back to where it started rather than
    // stranding it against an edge.
    document.addEventListener("pointerleave", () => {
        tx = window.innerWidth * 0.5;
        ty = window.innerHeight * 0.34;
        wake();
    });
    window.addEventListener("resize", () => {
        tx = Math.min(tx, window.innerWidth);
        ty = Math.min(ty, window.innerHeight);
        wake();
    }, {passive: true});
};

// ---------- reveals ----------
//
// One observer for everything that enters. `--i` on the element carries the
// stagger, so the three beats land one, two, three without three observers and
// without a timer that can drift out of step with the scroll.
Landing.reveals = function () {
    const items = document.querySelectorAll(".pop, .rise");
    if (!items.length) return;
    if (Landing.reduced() || !("IntersectionObserver" in window)) {
        items.forEach((el) => el.classList.add("in"));
        return;
    }
    const io = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            e.target.classList.add("in");
            io.unobserve(e.target);
        }
    }, {
        // Fires as the element crosses into the middle band of the viewport,
        // which is where the reader is looking.
        rootMargin: "0px 0px -22% 0px",
        threshold: 0.12,
    });
    items.forEach((el) => io.observe(el));
    document.documentElement.classList.add("motion-ready");
};

// ---------- measured failure sequence ----------
Landing.failures = function () {
    const root = document.querySelector("[data-failure-ledger]");
    if (!root) return;
    const proofs = [...root.querySelectorAll("[data-failure-proof]")];
    const current = root.querySelector("[data-failure-current]");
    if (!proofs.length) return;

    const choose = (proof) => {
        const index = proofs.indexOf(proof);
        if (index < 0) return;
        proofs.forEach((item) => item.classList.toggle("is-current", item === proof));
        if (current) current.textContent = String(index + 1).padStart(2, "0");
    };

    if (
        Landing.reduced()
        || !("IntersectionObserver" in window)
        || !window.matchMedia("(min-width: 821px)").matches
    ) {
        proofs.forEach((proof) => proof.classList.add("is-current"));
        return;
    }

    root.classList.add("has-motion");
    const io = new IntersectionObserver((entries) => {
        const visible = entries
            .filter((entry) => entry.isIntersecting)
            .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible.length) choose(visible[0].target);
    }, {
        // A narrow middle band makes one measured result own the reading moment.
        rootMargin: "-30% 0px -30% 0px",
        threshold: [0, 0.2, 0.45, 0.7],
    });
    proofs.forEach((proof) => io.observe(proof));
};

// ---------- propagation sequence ----------
Landing.propagation = function () {
    const root = document.querySelector("[data-propagation]");
    if (!root) return;
    const buttons = [...root.querySelectorAll("[data-prop-phase]")];
    const note = root.querySelector("[data-prop-note]");
    if (!buttons.length) return;

    const notes = {
        commit: "The network receives the trader, timestamp, bond and one fixed-length commitment. Side, price, quantity and salt are absent.",
        cancel: "The single clock has closed cancellation. Reveal opens at the same boundary, leaving no last-look overlap.",
        reveal: "When reveal opens, side, price, quantity, salt and backing become public transaction inputs. The commitment protected when, not who.",
        publish: "The first cancellation uses the public-activity allowance. The next valid cancellation completes without a venue event, and the consensus record makes that silence checkable.",
    };
    const labels = {
        commit: "fixed length",
        cancel: "cancel closed",
        reveal: "opening public",
        publish: "disclosure accounted",
    };
    const sealStatus = root.querySelector(".prop-path-sealed .prop-status");

    const choose = (phase) => {
        if (!Object.prototype.hasOwnProperty.call(notes, phase)) return;
        root.dataset.phase = phase;
        buttons.forEach((button) => {
            button.setAttribute("aria-pressed", String(button.dataset.propPhase === phase));
        });
        if (note) note.textContent = notes[phase];
        if (sealStatus) sealStatus.textContent = labels[phase];
    };

    root.classList.add("is-interactive");
    buttons.forEach((button, index) => {
        button.addEventListener("click", () => choose(button.dataset.propPhase));
        button.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const direction = event.key === "ArrowRight" ? 1 : -1;
            const next = (index + direction + buttons.length) % buttons.length;
            buttons[next].focus();
            choose(buttons[next].dataset.propPhase);
        });
    });
    choose(root.dataset.phase || "commit");
};

// ---------- disclosure lattice ----------
//
// Use the same point, permits, and excess helpers as the receipt screens. The
// visual is therefore a view of the packed ideal, not a second lattice model.
Landing.latticeModel = function (policyName, g, t) {
    const a = point(G.AGG, T.IMM);
    const b = point(G.EXACT, T.EOD);
    const policies = {
        aggregate: a,
        "exact-eod": b,
        combined: (a | b) >>> 0,
    };
    const validG = Number.isInteger(g) && g >= G.NONE && g <= G.EXACT;
    const validT = Number.isInteger(t) && t >= T.PRE && t <= T.NEVER;
    const selectedG = validG ? g : G.AGG;
    const selectedT = validT ? t : T.IMM;
    const ceiling = policies[policyName] ?? policies.combined;
    const actual = point(selectedG, selectedT);
    return {
        a,
        b,
        combined: policies.combined,
        ceiling,
        actual,
        g: selectedG,
        t: selectedT,
        allowed: permits(ceiling, actual),
        over: excess(ceiling, actual),
    };
};

Landing.latticeDetails = ["None", "Yes/no", "Summary", "Range", "Exact value"];
Landing.latticeContractDetails = ["none", "predicate", "aggregate", "bucket", "exact"];
Landing.latticeTimes = ["Before", "Now", "+15 min", "Day close", "Epoch", "Never"];
Landing.latticeContractTimes = ["pre", "immediate", "+15m", "EOD", "epoch", "never"];

Landing.latticeExplanation = function (model) {
    const g = model.g;
    const t = model.t;
    if (g === G.NONE && t === T.NEVER) {
        return "None means no detail, and Never means no publication in this model.";
    }
    if (g === G.NONE) {
        return model.allowed
            ? "None is the no-detail level in this model."
            : "None is the no-detail level; the example policy begins at Now.";
    }
    if (t === T.NEVER) {
        return model.allowed
            ? "Never means the venue does not publish this detail in the model."
            : "Never means no publication; the selected detail is still outside this policy.";
    }
    if (model.allowed) {
        const detail = g === G.EXACT ? "Exact detail" : Landing.latticeDetails[g];
        const timing = {
            [T.PRE]: "before the event",
            [T.IMM]: "now",
            [T.M15]: "after 15 minutes",
            [T.EOD]: "from day close",
            [T.EPOCH]: "from the epoch boundary",
        }[t];
        return detail + " can be published " + timing + " under this example policy.";
    }

    let firstPermitted = null;
    for (let candidateT = T.PRE; candidateT <= T.NEVER; candidateT++) {
        if (permits(model.ceiling, point(g, candidateT))) {
            firstPermitted = candidateT;
            break;
        }
    }
    const detail = g === G.EXACT
        ? "Exact detail"
        : g === G.BUCKET
            ? "Range detail"
            : Landing.latticeDetails[g];
    if (firstPermitted === null) {
        return detail + " is outside this policy at every timing category.";
    }
    const from = {
        [T.IMM]: "now",
        [T.M15]: "15 minutes",
        [T.EOD]: "day close",
        [T.EPOCH]: "the epoch boundary",
        [T.NEVER]: "never",
    }[firstPermitted] || "the selected time";
    return detail + " is permitted from " + from + ".";
};

Landing.renderLatticeSurface = function (root, state) {
    const model = Landing.latticeModel(state.policy, state.g, state.t);
    const cells = [...root.querySelectorAll("[data-lattice-cell]")];
    const matrix = root.querySelector("[data-lattice-matrix]");
    const result = root.querySelector("[data-lattice-result]");
    const resultExplanation = root.querySelector("[data-lattice-result-explanation]");
    const ceiling = root.querySelector("[data-lattice-ceiling]");
    const actual = root.querySelector("[data-lattice-actual]");
    const policyButtons = [...root.querySelectorAll("[data-lattice-policy]")];
    const policySlider = root.querySelector("[data-lattice-policy-slider]");
    const policyControl = root.querySelector("[data-lattice-policy-control]");
    const policyLabels = [...root.querySelectorAll("[data-lattice-policy-label]")];

    root.dataset.policy = state.policy;
    root.dataset.g = String(model.g);
    root.dataset.t = String(model.t);
    root.dataset.result = model.allowed ? "inside" : "outside";

    policyButtons.forEach((button) => {
        button.setAttribute(
            "aria-pressed",
            String(button.dataset.latticePolicy === state.policy),
        );
    });
    if (policySlider) {
        const policies = ["aggregate", "exact-eod", "combined"];
        const selectedIndex = policies.indexOf(state.policy);
        const policyIndex = selectedIndex >= 0 ? selectedIndex : 2;
        policySlider.value = String(policyIndex);
        policySlider.setAttribute(
            "aria-valuetext",
            ["Aggregate now", "Exact at EOD", "Combined policy"][policyIndex],
        );
    }
    if (policyControl) policyControl.dataset.policy = state.policy;
    policyLabels.forEach((label) => {
        label.dataset.active = String(label.dataset.latticePolicyLabel === state.policy);
    });

    cells.forEach((cell) => {
        const g = Number(cell.dataset.g);
        const t = Number(cell.dataset.t);
        const bit = (1 << (g * 6 + t)) >>> 0;
        const inA = (model.a & bit) !== 0;
        const inB = (model.b & bit) !== 0;
        let membership = "none";
        if (state.policy === "aggregate" && inA) membership = "a";
        if (state.policy === "exact-eod" && inB) membership = "b";
        if (state.policy === "combined") {
            if (inA && inB) membership = "both";
            else if (inA) membership = "a";
            else if (inB) membership = "b";
        }
        const selected = g === model.g && t === model.t;
        cell.disabled = false;
        cell.dataset.membership = membership;
        cell.dataset.permitted = String((model.ceiling & bit) !== 0);
        cell.classList.toggle("is-implied", (model.actual & bit) !== 0);
        cell.classList.toggle("is-excess", (model.over & bit) !== 0);
        cell.classList.toggle("is-selected", selected);
        cell.setAttribute("aria-pressed", String(selected));
        cell.tabIndex = selected ? 0 : -1;
    });

    if (result) result.textContent = model.allowed ? "Within policy" : "Outside policy";
    if (resultExplanation) {
        resultExplanation.textContent = root.dataset.latticeSurface === "popup"
            ? model.allowed
                ? "Every cell implied by this publication fits within the selected policy."
                : "This publication includes detail or timing outside the selected policy."
            : Landing.latticeExplanation(model);
    }
    if (matrix) {
        matrix.setAttribute(
            "aria-label",
            Landing.latticeDetails[model.g] + ", " + Landing.latticeTimes[model.t] +
            ". " + (model.allowed ? "Within policy." : "Outside policy."),
        );
    }
    if (ceiling) {
        ceiling.textContent = "ceiling = " + ({
            aggregate: "A",
            "exact-eod": "B",
            combined: "A ∪ B",
        }[state.policy] || "A ∪ B");
    }
    if (actual) {
        actual.textContent = "actual = ↓(" +
            Landing.latticeContractDetails[model.g] + ", " +
            Landing.latticeContractTimes[model.t] + ")";
    }
    return model;
};

Landing.bindLatticeGrid = function (root, state, render) {
    const cells = [...root.querySelectorAll("[data-lattice-cell]")];
    if (!cells.length) return;

    const cellAt = (g, t) =>
        cells.find((cell) => Number(cell.dataset.g) === g && Number(cell.dataset.t) === t);
    const moveFocus = (from, key) => {
        let g = Number(from.dataset.g);
        let t = Number(from.dataset.t);
        if (key === "ArrowUp") g = Math.min(G.EXACT, g + 1);
        else if (key === "ArrowDown") g = Math.max(G.NONE, g - 1);
        else if (key === "ArrowLeft") t = Math.max(T.PRE, t - 1);
        else if (key === "ArrowRight") t = Math.min(T.NEVER, t + 1);
        else return false;
        const next = cellAt(g, t);
        if (!next) return false;
        cells.forEach((cell) => {
            cell.tabIndex = cell === next ? 0 : -1;
        });
        next.focus();
        return true;
    };
    const select = (cell) => {
        state.g = Number(cell.dataset.g);
        state.t = Number(cell.dataset.t);
        render();
    };

    cells.forEach((cell) => {
        cell.addEventListener("click", () => select(cell));
        cell.addEventListener("keydown", (event) => {
            if (moveFocus(cell, event.key)) {
                event.preventDefault();
                return;
            }
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            select(cell);
        });
    });
};

Landing.bindLatticeChoices = function (buttons, choose) {
    buttons.forEach((button, index) => {
        button.addEventListener("click", () => choose(button.dataset.latticePolicy));
        button.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const direction = event.key === "ArrowRight" ? 1 : -1;
            const next = (index + direction + buttons.length) % buttons.length;
            buttons[next].focus();
            choose(buttons[next].dataset.latticePolicy);
        });
    });
};

Landing.lattice = function () {
    const landing = document.querySelector('[data-lattice-surface="landing"]');
    const dialog = document.getElementById("lattice-dialog");
    const openButton = document.querySelector("[data-lattice-open]");
    if (!landing) return;

    const initialG = Number(landing.dataset.g);
    const initialT = Number(landing.dataset.t);
    const landingState = {
        policy: "combined",
        g: Number.isInteger(initialG) ? initialG : G.AGG,
        t: Number.isInteger(initialT) ? initialT : T.IMM,
    };
    const renderLanding = () => Landing.renderLatticeSurface(landing, landingState);
    const landingSlider = landing.querySelector("[data-lattice-policy-slider]");
    const landingPolicyControl = landing.querySelector("[data-lattice-policy-control]");
    const landingLiveResult = landing.querySelector("[data-lattice-result-line]");
    if (landingSlider && landingPolicyControl) {
        const policies = ["aggregate", "exact-eod", "combined"];
        landingSlider.disabled = false;
        landingPolicyControl.hidden = false;
        landingSlider.addEventListener("input", () => {
            const index = Math.max(0, Math.min(2, Math.round(Number(landingSlider.value))));
            landingState.policy = policies[index];
            renderLanding();
        });
    }
    if (landingLiveResult) landingLiveResult.hidden = false;
    Landing.bindLatticeGrid(landing, landingState, renderLanding);
    renderLanding();

    if (!dialog || !openButton || typeof dialog.showModal !== "function") return;
    const popup = dialog.querySelector('[data-lattice-surface="popup"]');
    const popupGrid = dialog.querySelector("[data-lattice-popup-grid]");
    const landingGrid = landing.querySelector(".lattice-grid-layout");
    if (!popup || !popupGrid || !landingGrid) return;

    popupGrid.replaceChildren(landingGrid.cloneNode(true));
    const popupState = {policy: "combined", g: landingState.g, t: landingState.t};
    const renderPopup = () => Landing.renderLatticeSurface(popup, popupState);
    Landing.bindLatticeGrid(popup, popupState, renderPopup);

    const policyButtons = [...popup.querySelectorAll("[data-lattice-policy]")];
    Landing.bindLatticeChoices(policyButtons, (policy) => {
        popupState.policy = policy;
        renderPopup();
    });

    const tabs = [...dialog.querySelectorAll('[role="tab"]')];
    const panels = [...dialog.querySelectorAll('[role="tabpanel"]')];
    const activateTab = (tab, focus = false) => {
        tabs.forEach((item) => {
            const active = item === tab;
            item.setAttribute("aria-selected", String(active));
            item.tabIndex = active ? 0 : -1;
        });
        panels.forEach((panel) => {
            panel.hidden = panel.id !== tab.getAttribute("aria-controls");
        });
        if (focus) tab.focus();
    };
    tabs.forEach((tab, index) => {
        tab.addEventListener("click", () => activateTab(tab));
        tab.addEventListener("keydown", (event) => {
            let next = null;
            if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
            if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
            if (event.key === "Home") next = 0;
            if (event.key === "End") next = tabs.length - 1;
            if (next === null) return;
            event.preventDefault();
            activateTab(tabs[next], true);
        });
    });

    let returnFocus = openButton;
    let lockedScroll = 0;
    let scrollLocked = false;
    const unlock = () => {
        if (!scrollLocked) return;
        scrollLocked = false;
        document.documentElement.classList.remove("lattice-dialog-open");
        window.scrollTo(0, lockedScroll);
        if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    };
    const closeDialog = () => {
        if (dialog.open) dialog.close();
        unlock();
    };
    dialog.addEventListener("close", unlock);
    dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        closeDialog();
    });
    dialog.querySelector("[data-lattice-close]")?.addEventListener("click", () => {
        closeDialog();
    });

    openButton.hidden = false;
    openButton.addEventListener("click", () => {
        popupState.policy = "combined";
        popupState.g = landingState.g;
        popupState.t = landingState.t;
        renderPopup();
        if (tabs[0]) activateTab(tabs[0]);
        returnFocus = document.activeElement || openButton;
        lockedScroll = window.scrollY;
        scrollLocked = true;
        document.documentElement.classList.add("lattice-dialog-open");
        dialog.showModal();
        popup.querySelector(".lattice-cell.is-selected")?.focus();
    });
};

// ---------- the scroll invitation ----------
Landing.cue = function () {
    const cues = [...document.querySelectorAll(".scroll-cue")];
    if (!cues.length) return;

    // Only the fold invitation hides once the reader has moved. The bar on
    // later frames stays put; it is already below the fold.
    const heroCue = document.getElementById("cue");
    if (heroCue) {
        const onScroll = () => {
            heroCue.classList.toggle("gone", window.scrollY > 60);
        };
        window.addEventListener("scroll", onScroll, {passive: true});
        onScroll();
    }

    cues.forEach((cue) => {
        cue.addEventListener("click", (e) => {
            const id = (cue.getAttribute("href") || "").replace(/^#/, "");
            const target = id && document.getElementById(id);
            if (!target) return;
            e.preventDefault();
            target.scrollIntoView({
                behavior: Landing.reduced() ? "auto" : "smooth",
                block: "start",
            });
        });
    });
};

Landing.boot = function () {
    Landing.aura();
    Landing.failures();
    Landing.propagation();
    Landing.lattice();
    Landing.reveals();
    Landing.cue();
};
