// Front-door behaviour: the light that follows the cursor, the scroll
// invitation, the staggered reveals, and the fanned deck.
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
// stagger, so the three doors land one, two, three without three observers and
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

// ---------- the fanned deck ----------
//
// Cards overlap by a fixed margin. Pointing at one raises it and pushes its
// neighbours outward: everything to its left shifts left, everything to its
// right shifts right, so the raised card gets room without the row changing
// width. Focus does the same thing as hover, so the deck opens from a keyboard.
Landing.deck = function () {
    const deck = document.getElementById("deck");
    if (!deck) return;
    const cards = [...deck.querySelectorAll(".fcard")];
    if (!cards.length) return;

    // A shallow fan at rest: outer cards tilt away from the middle.
    const mid = (cards.length - 1) / 2;
    cards.forEach((c, i) => {
        c.style.setProperty("--tilt", ((i - mid) * 0.9).toFixed(2));
        c.style.setProperty("--z", String(i));
    });

    const clear = () => {
        cards.forEach((c, i) => {
            c.classList.remove("up");
            c.style.setProperty("--shift", "0");
            c.style.setProperty("--z", String(i));
        });
    };

    const raise = (i) => {
        cards.forEach((c, j) => {
            const up = j === i;
            c.classList.toggle("up", up);
            c.style.setProperty("--shift", up ? "0" : (j < i ? "-1" : "1"));
            c.style.setProperty("--z", up ? "40" : String(j));
        });
    };

    cards.forEach((c, i) => {
        c.addEventListener("pointerenter", (e) => {
            if (e.pointerType === "touch") return;
            raise(i);
        });
        c.addEventListener("focusin", () => raise(i));
    });
    deck.addEventListener("pointerleave", clear);
    deck.addEventListener("focusout", (e) => {
        if (!deck.contains(e.relatedTarget)) clear();
    });
    clear();
};

Landing.boot = function () {
    Landing.aura();
    Landing.reveals();
    Landing.cue();
    Landing.deck();
};
