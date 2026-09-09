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
    Landing.reveals();
    Landing.cue();
};
