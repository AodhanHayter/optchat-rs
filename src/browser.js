// Offline snapshot viewer for an OptChat memory directory.
// It reads one embedded JSON block and builds every element with createElement and
// textContent. History text is never parsed as markup, never used as a URL, and never
// evaluated. The page makes no network request and the document CSP forbids one.
(() => {
  // One page of search hits, matching the Rust `search` contract.
  const PAGE = 20;
  // View parts per group. Only an opened group materialises its parts, so revealing a
  // message never builds the parts of other groups.
  const PARTS = 200;
  // Characters kept around a match, and characters of leading context.
  const SNIPPET = 240;
  const LEAD = 48;
  // Query bounds, in UTF-8 bytes, matching the Rust search contract.
  const QUERY = 256;
  const KINDS = ["user", "talk", "work", "note"];
  const TOOL_KINDS = ["tool", "echo"];
  const PENDING = "(not summarized yet)";

  // Keep the serialized block intact so a saved copy of the live page can reopen.
  const data = JSON.parse(document.getElementById("snapshot").textContent);
  const summaries = new Map();

  for (const entry of data.tree) {
    summaries.set(`${entry[0]}:${entry[1]}`, entry[2]);
  }

  // The lookup now owns the summary references. Release the duplicate entry arrays.
  data.tree.length = 0;

  // Each details element keeps its own tree position and lazily built children.
  const places = new WeakMap();
  const groups = [];

  const find = (id) => document.getElementById(id);
  const tree = find("tree");
  const results = find("results");
  const older = find("older");
  const report = find("report");
  const form = find("search-form");
  const query = find("query");
  const tools = find("tools");
  // The submitted query, so editing the box cannot mix two searches into one list.
  let active = null;
  let cursor = null;

  const el = (tag, className = "", text = null) => {
    const node = document.createElement(tag);

    if (className !== "") {
      node.className = className;
    }

    if (text !== null) {
      node.textContent = text;
    }

    return node;
  };

  const width = (l) => 2 ** l;
  const first = (l, i) => i * width(l);
  const dateOf = (index) => (index < data.root.length ? data.root[index].date : "");

  const span = (l, i) => {
    const from = first(l, i);
    const last = Math.min(from + width(l), data.root.length) - 1;
    const dates = from === last ? dateOf(from) : `${dateOf(from)} — ${dateOf(last)}`;

    return `${from}+${width(l)} · ${dates}`;
  };

  // ---- tree -------------------------------------------------------------
  const original = (index) => {
    const message = data.root[index];
    const box = el("section", "message");
    box.id = `m${index}`;
    box.tabIndex = -1;
    box.append(
      el("h4", "", `message ${index} · ${message.kind} · ${message.date} · ${message.size} bytes`),
    );
    box.append(el("pre", "text", message.text));

    return box;
  };

  const node = (l, i) => {
    const details = el("details", "node");
    const head = el("summary");
    const text = summaries.get(`${l}:${i}`);
    head.append(el("span", "range", span(l, i)));
    head.append(document.createTextNode(" "));

    if (text === undefined) {
      head.append(el("span", "pending", "pending summary"));
    } else {
      head.append(el("span", "state", `${text.length} chars`));
    }

    const body = el("div", "body");
    details.append(head, body);
    places.set(details, { l, i, body, children: null, built: false });
    details.addEventListener("toggle", () => {
      if (details.open) {
        build(details);
      }
    });

    return details;
  };

  // Children appear only when a node is opened, so a 100k-message history never
  // materialises 100k elements. Opening twice must not duplicate them.
  const build = (details) => {
    const place = places.get(details);

    if (place.built) {
      return place;
    }

    place.built = true;
    const text = summaries.get(`${place.l}:${place.i}`);
    place.body.append(el("pre", "summary", text === undefined ? PENDING : text));

    if (place.l === 0) {
      place.body.append(original(place.i));

      return place;
    }

    const children = [node(place.l - 1, place.i * 2), node(place.l - 1, place.i * 2 + 1)];
    const box = el("div", "children");
    box.append(children[0], children[1]);
    place.body.append(box);
    place.children = children;

    return place;
  };

  // A group builds its own parts once, whether a reader opens it or a search reveals
  // a message inside it.
  const fillGroup = (g) => {
    const group = groups[g];

    if (group.built) {
      return group;
    }

    group.built = true;
    const batch = document.createDocumentFragment();
    const limit = Math.min((g + 1) * PARTS, data.parts.length);

    for (let at = g * PARTS; at < limit; at++) {
      const part = node(data.parts[at][0], data.parts[at][1]);
      group.parts.push(part);
      batch.append(part);
    }

    group.body.append(batch);

    return group;
  };

  const renderTree = () => {
    if (data.parts.length === 0) {
      tree.append(el("p", "", "This memory has no messages yet."));

      return;
    }

    const count = Math.ceil(data.parts.length / PARTS);

    for (let g = 0; g < count; g++) {
      // A short view needs no grouping at all.
      if (count === 1) {
        groups.push({ details: null, body: tree, parts: [], built: false });
        fillGroup(g);
        continue;
      }

      const from = g * PARTS;
      const to = Math.min(from + PARTS, data.parts.length) - 1;
      const head = first(data.parts[from][0], data.parts[from][1]);
      const tail = first(data.parts[to][0], data.parts[to][1]) + width(data.parts[to][0]) - 1;
      const details = el("details", "group");
      const body = el("div", "body");
      details.append(
        el("summary", "range", `view parts ${from}–${to} · messages ${head}–${tail}`),
        body,
      );
      groups.push({ details, body, parts: [], built: false });
      details.addEventListener("toggle", () => {
        if (details.open) {
          fillGroup(g);
        }
      });
      tree.append(details);
    }
  };

  // Opens the covering view part and every summary down to one original message.
  const reveal = (index) => {
    let at = -1;

    for (let p = 0; p < data.parts.length; p++) {
      const start = first(data.parts[p][0], data.parts[p][1]);

      if (start <= index && index < start + width(data.parts[p][0])) {
        at = p;
        break;
      }
    }

    if (at < 0) {
      return false;
    }

    const g = Math.floor(at / PARTS);
    const group = fillGroup(g);

    if (group.details !== null) {
      group.details.open = true;
    }

    let element = group.parts[at - g * PARTS];

    for (;;) {
      // The toggle event is asynchronous, so build before opening, not after.
      const place = build(element);
      element.open = true;

      if (place.l === 0) {
        break;
      }

      element = place.children[index < first(place.l - 1, place.i * 2 + 1) ? 0 : 1];
    }

    const target = find(`m${index}`);
    target.scrollIntoView();
    target.focus();

    return true;
  };

  // ---- search -----------------------------------------------------------
  // Literal search folding ASCII case only; every other character must match exactly,
  // like the Rust engine. The pattern is built from escaped literals and two-character
  // classes, so it has no quantifier and cannot backtrack.
  const matcher = (text) => {
    let source = "";

    for (const ch of text) {
      const code = ch.codePointAt(0);

      if ((code >= 97 && code <= 122) || (code >= 65 && code <= 90)) {
        source += `[${ch.toLowerCase()}${ch.toUpperCase()}]`;
      } else if (code < 32 || code === 127) {
        source += `\\u${code.toString(16).padStart(4, "0")}`;
      } else if ("\\^$.*+?()[]{}|/-".includes(ch)) {
        source += `\\${ch}`;
      } else {
        source += ch;
      }
    }

    return new RegExp(source);
  };

  const snippet = (text, at, length) => {
    let from = Math.max(0, at - LEAD);

    // UTF-16 offsets must not bisect a supplementary Unicode character.
    if (text.charCodeAt(from) >= 0xdc00 && text.charCodeAt(from) <= 0xdfff) from--;
    let end = Math.min(text.length, from + SNIPPET);

    if (text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
    const head = from > 0 ? "…" : "";
    const body = text.slice(from, end);
    const tail = end < text.length ? "…" : "";
    const start = at - from;
    const line = el("p", "snippet");
    line.append(document.createTextNode(head + body.slice(0, start)));
    line.append(el("mark", "", body.slice(start, start + length)));
    line.append(document.createTextNode(body.slice(start + length) + tail));

    return line;
  };

  const hit = (index, at, length) => {
    const message = data.root[index];
    const item = el("li");
    item.append(el("h3", "", `message ${index} · ${message.kind} · ${message.date}`));
    item.append(snippet(message.text, at, length));
    const open = el("button", "", "Reveal original and its summaries");
    open.type = "button";
    open.addEventListener("click", () => {
      if (!reveal(index)) {
        report.textContent = `Message ${index} is outside the current view.`;
      }
    });
    item.append(open);

    return item;
  };

  // Newest id first, at most one page, with an exclusive cursor for older hits.
  // One extra match decides the cursor; matches are never counted or collected.
  const page = (text, before, includeTools) => {
    const regex = matcher(text);
    const hits = [];
    let next = null;

    for (let index = Math.min(before ?? data.root.length, data.root.length) - 1; index >= 0; index--) {
      const message = data.root[index];

      const wanted =
        KINDS.includes(message.kind) || (includeTools && TOOL_KINDS.includes(message.kind));

      if (!wanted) {
        continue;
      }

      const found = regex.exec(message.text);

      if (found === null) {
        continue;
      }

      if (hits.length === PAGE) {
        next = hits[hits.length - 1].index;
        break;
      }

      hits.push({ index, at: found.index, length: found[0].length });
    }

    return { hits, next };
  };

  const run = (before) => {
    const found = page(active.text, before, active.tools);
    results.replaceChildren();

    for (const entry of found.hits) {
      results.append(hit(entry.index, entry.at, entry.length));
    }

    cursor = found.next;
    older.hidden = found.next === null;
    const shown = results.childElementCount;

    if (shown === 0) {
      report.textContent = "No original message contains that text.";
    } else {
      report.textContent = `${shown} matching message${shown === 1 ? "" : "s"} on this page${
        found.next === null ? "; no older matches." : "; older matches remain."
      }`;
    }
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = query.value;
    const bytes = new TextEncoder().encode(text).length;
    results.replaceChildren();
    older.hidden = true;

    if (bytes === 0 || bytes > QUERY) {
      report.textContent = `Search text must be 1 to ${QUERY} bytes.`;

      return;
    }

    if (text.trim() === "") {
      report.textContent = "Search text must not be whitespace only.";

      return;
    }

    active = { text, tools: tools.checked };
    run(null);
  });
  older.addEventListener("click", () => run(cursor));
  renderTree();
})();
