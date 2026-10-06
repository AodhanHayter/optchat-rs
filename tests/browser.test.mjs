import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../src/browser.js", import.meta.url), "utf8");

// Only the DOM operations used by search. Run the shipped script, not a copy of
// its search logic. Real-browser checks cover layout and native tree interactions.
class Element {
  children = [];
  listeners = {};
  value = "";
  checked = false;
  hidden = false;
  text = "";
  get textContent() { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this.text = value; this.children = []; }
  get childElementCount() { return this.children.length; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
}

function viewer(texts) {
  const nodes = new Map(["snapshot", "tree", "results", "older", "report", "search-form", "query", "tools"].map(id => [id, new Element()]));
  nodes.get("snapshot").textContent = JSON.stringify({
    parts: [], tree: [], root: texts.map((text, id) => ({ id, text, kind: "user", date: "2026-10-06", size: Buffer.byteLength(text) })),
  });
  runInNewContext(script, {
    TextEncoder,
    document: {
      getElementById: id => nodes.get(id),
      createElement: () => new Element(),
      createTextNode: text => {
        const node = new Element();
        node.textContent = text;

        return node;
      },
    },
  });

  return {
    search(text) {
      nodes.get("query").value = text;
      nodes.get("search-form").listeners.submit({ preventDefault() {} });
    },
    older: () => nodes.get("older").listeners.click(),
    nodes,
  };
}

test("snapshot search retains only one page with exclusive descending cursors", () => {
  const v = viewer(Array.from({ length: 41 }, () => "MATCH"));
  const ids = () => v.nodes.get("results").children.map(item => Number(item.children[0].textContent.split(" ")[1]));
  v.search("match");
  assert.deepEqual(ids(), Array.from({ length: 20 }, (_, i) => 40 - i));
  v.older();
  assert.deepEqual(ids(), Array.from({ length: 20 }, (_, i) => 20 - i));
  v.older();
  assert.deepEqual(ids(), [0]);
  assert.equal(v.nodes.get("older").hidden, true);
});

test("snapshot snippets do not split Unicode at either clipping boundary", () => {
  for (const [text, query] of [
    ["a".repeat(239) + "🦀b", "a"],
    ["🦀" + "a".repeat(47) + "match" + "b".repeat(240), "match"],
  ]) {
    const v = viewer([text]);
    v.search(query);
    const snippet = v.nodes.get("results").children[0].children[1];
    assert.equal(snippet.textContent.isWellFormed(), true, "whole snippet");

    for (const child of snippet.children) assert.equal(child.textContent.isWellFormed(), true, "each text/mark node");
  }
});
