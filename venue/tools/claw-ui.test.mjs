import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("../", import.meta.url);
const PRIME_TEMPLATES = [
    "index",
    "prove",
    "trade",
    "position",
    "venue",
    "repo",
];

test("Lattice Claw is one coming-soon frame with an active offline chat bar", async () => {
    const [template, css] = await Promise.all([
        readFile(new URL("app/claw/index.template.html", ROOT), "utf8"),
        readFile(new URL("app/claw/claw.css", ROOT), "utf8"),
    ]);

    assert.equal((template.match(/class="claw-frame"/g) ?? []).length, 1);
    assert.equal((template.match(/class="claw-hero"/g) ?? []).length, 1);
    assert.match(template, />COMING SOON 🚀</);
    assert.doesNotMatch(template, /coming-blob/);
    assert.match(template, /id="claw-prompt"/);
    assert.doesNotMatch(template, /\breadonly\b|\bdisabled\b/);
    assert.match(template, /<button type="submit" aria-label="Send message"/);
    assert.match(template, /id="claw-log" aria-live="polite"/);
    assert.doesNotMatch(template, /innerHTML/);
    assert.match(
        template,
        /class="claw-brand-switch" href="\.\.\/index\.html" aria-label="Switch to Lattice Prime"/
    );
    assert.match(template, /<a class="claw-brand-home" href="index\.html">Lattice Claw<\/a>/);
    // The chat bar answers locally: no venue modules, no network, nothing fetched.
    assert.doesNotMatch(template, /agent-client|client-bundle|Venue\.boot|fetch\(|XMLHttpRequest|WebSocket/);
    assert.doesNotMatch(template, /https?:\/\//);
    assert.match(css, /\.claw-frame\{[\s\S]*min-height:calc\(100svh - 5\.1rem\)/);
    assert.match(css, /@media\(max-width:600px\)/);
    assert.match(css, /@media\(prefers-reduced-motion:no-preference\)/);
});

test("every Lattice Prime logo switches to Claw and the wordmark goes home", async () => {
    const pages = await Promise.all(
        PRIME_TEMPLATES.map(async (name) => ({
            name,
            source: await readFile(new URL(`app/${name}.template.html`, ROOT), "utf8"),
        }))
    );
    for (const {name, source} of pages) {
        assert.match(
            source,
            /<a class="brand-switch" href="claw\/" aria-label="Switch to Lattice Claw"/,
            `${name} logo must switch to Lattice Claw`
        );
        assert.match(
            source,
            /<a class="brand-home" href="index\.html">Lattice Prime<\/a>/,
            `${name} wordmark must land on the Prime home page`
        );
    }

    const markets = pages.find(({name}) => name === "trade").source;
    const portfolio = pages.find(({name}) => name === "position").source;
    assert.doesNotMatch(markets, /agent-workspace|INLINE tools\/agent-(?:client|ui)\.mjs/);
    assert.doesNotMatch(
        portfolio,
        /agent-receipts|INLINE tools\/agent-(?:client|receipts-ui)\.mjs/
    );
});
