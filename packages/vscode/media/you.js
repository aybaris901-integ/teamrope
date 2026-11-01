// YOU panel: draws the model sent by the extension. No text of its own except
// the welcome states; every action goes back to the extension as a message.
// @ts-check
(function () {
  // @ts-ignore - provided by VS Code inside webviews
  const vscode = acquireVsCodeApi();
  const root = /** @type {HTMLElement} */ (document.getElementById("root"));

  /** @param {string} tag @param {string} [className] @param {string} [text] */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** @param {string} name */
  function icon(name) {
    const node = el("span", `codicon codicon-${name}`);
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  /** @param {{label: string, command: string, icon: string}} b @param {string} kind */
  function button(b, kind) {
    const node = el("button", `button ${kind}`);
    node.append(icon(b.icon), el("span", "", b.label));
    node.addEventListener("click", () => vscode.postMessage({ type: "run", command: b.command }));
    return node;
  }

  /** @param {string} label @param {() => void} onClick */
  function link(label, onClick) {
    const node = el("button", "link", label);
    node.addEventListener("click", onClick);
    return node;
  }

  /** @param {string} text @param {Array<{label: string, command: string, icon: string}>} buttons */
  function welcome(text, buttons) {
    root.append(el("p", "welcome", text));
    for (const b of buttons) root.append(button(b, "primary block"));
  }

  /** The model last drawn, and the timeline row whose card is open (kept across updates). */
  let lastModel = null;
  /** @type {string | null} */
  let selected = null;

  /** @param {any} p */
  function problemItem(p) {
    const item = el("li", `problem ${p.kind}`);
    const text = el("button", "problem-text");
    text.append(icon(PROBLEM_ICONS[p.kind] ?? "warning"), el("span", "", p.text));
    text.addEventListener("click", () => vscode.postMessage({ type: "problem", index: p.index, action: "details" }));
    const actions = el("div", "problem-actions");
    if (p.canCompare) {
      actions.append(link("Compare", () => vscode.postMessage({ type: "problem", index: p.index, action: "compare" })));
    }
    actions.append(link("Copy message", () => vscode.postMessage({ type: "problem", index: p.index, action: "copy" })));
    item.append(text, actions);
    return item;
  }

  /** @param {HTMLElement} track @param {string} className @param {number} x @param {string} [text] */
  function at(track, className, x, text) {
    const node = el("span", className, text);
    node.style.left = `${x}%`;
    if (x > 95) node.classList.add("end");
    track.append(node);
    return node;
  }

  /** @param {any} row */
  function timelineCard(row) {
    const card = el("div", "tl-card");
    card.append(el("p", "tl-card-head", row.summary));
    if (row.card.problems.length > 0) {
      const list = el("ul", "problems");
      for (const p of row.card.problems) list.append(problemItem(p));
      card.append(list);
    }
    if (row.card.commits.length > 0) {
      const commits = el("ul", "tl-commits");
      for (const line of row.card.commits) commits.append(el("li", "", line));
      card.append(commits);
    }
    if (row.card.sync) card.append(button(row.card.sync, "secondary block"));
    return card;
  }

  /** One line per person: dots = shared commits, dashed = not shared, ≈ / ✕ = problems. @param {any} t */
  function timeline(t) {
    if (!t || t.rows.length === 0) return;
    const section = el("section", "timeline");
    section.setAttribute("aria-label", t.title);
    section.append(el("h2", "tl-title", t.title));
    for (const row of t.rows) {
      const open = selected === row.id;
      const line = el("button", `tl-row${open ? " selected" : ""}${row.isMe ? " me" : ""}`);
      line.dataset.id = row.id;
      line.title = row.summary;
      line.setAttribute("aria-label", row.summary);
      line.setAttribute("aria-expanded", String(open));

      const label = el("span", "tl-label");
      const avatar = el("span", "tl-avatar", row.initials);
      avatar.style.backgroundColor = row.color;
      avatar.setAttribute("aria-hidden", "true");
      label.append(avatar, el("span", "tl-name", row.label));

      const track = el("span", "tl-track");
      track.setAttribute("aria-hidden", "true");
      track.append(el("span", "tl-base"));
      if (row.notShared !== undefined) at(track, "tl-notshared", row.notShared);
      for (const shape of row.shapes) {
        at(track, `tl-problem ${shape.kind}`, shape.x);
        at(track, `tl-mark ${shape.kind}`, shape.x, shape.kind === "conflict" ? "✕" : "≈");
      }
      for (const dot of row.dots) at(track, "tl-dot", dot.x).title = dot.title;

      const duration = el("span", "tl-dur");
      duration.append(el("span", "tl-dur-long", row.duration), el("span", "tl-dur-short", row.durationShort));

      line.append(label, track, duration);
      line.addEventListener("click", () => {
        selected = open ? null : row.id;
        render(lastModel);
        // Keep keyboard focus on the same line after redrawing.
        root.querySelector(`.tl-row[data-id="${CSS.escape(row.id)}"]`)?.focus();
      });
      section.append(line);
      if (open) section.append(timelineCard(row));
    }
    const axis = el("div", "tl-axis");
    axis.setAttribute("aria-hidden", "true");
    const labels = el("span", "tl-axis-labels");
    for (const text of t.axis) labels.append(el("span", "", text));
    axis.append(el("span"), labels, el("span"));
    section.append(axis);
    root.append(section);
  }

  const SEVERITY_ICONS = { error: "error", warning: "warning", info: "info", ok: "pass" };
  const PROBLEM_ICONS = { mainConflict: "error", overlapWithMe: "warning", team: "warning" };

  /** @param {any} model */
  function render(model) {
    lastModel = model;
    root.replaceChildren();
    switch (model.state) {
      case "noFolder":
        return welcome("Open your team's repo folder to get started.", [
          { label: "Open Folder", command: "vscode.openFolder", icon: "folder-opened" },
        ]);
      case "noRepo":
        return welcome("This folder isn't a Git repo yet. Open your team's repo folder, or clone it.", [
          { label: "Clone Repository", command: "git.clone", icon: "repo-clone" },
          { label: "Open Folder", command: "vscode.openFolder", icon: "folder-opened" },
        ]);
      case "loading":
        root.append(el("p", "muted", "Checking your repo…"));
        return;
      case "error": {
        const row = el("p", "headline warning");
        row.append(icon("warning"), el("span", "", model.message));
        root.append(row);
        return;
      }
    }

    const head = el("div", `headline ${model.severity}`);
    head.append(icon(SEVERITY_ICONS[model.severity]), el("span", "", model.sentence));
    root.append(head);

    if (model.primary) root.append(button(model.primary, `${model.primary.style} block`));

    if (model.secondary.length > 0) {
      const secondary = el("div", "actions");
      for (const b of model.secondary) secondary.append(button(b, "small"));
      root.append(secondary);
    }

    if (model.problems.length > 0) {
      const list = el("ul", "problems");
      for (const p of model.problems) list.append(problemItem(p));
      root.append(list);
    }

    timeline(model.timeline);

    if (model.details.length === 0) return;
    // Collapsed by default; the chevron turns when it opens (you.css).
    const details = el("details", "details");
    const summary = el("summary");
    summary.append(icon("chevron-right"), el("span", "", "Details"));
    const lines = el("ul");
    for (const line of model.details) lines.append(el("li", "", line));
    details.append(summary, lines);
    root.append(details);
  }

  window.addEventListener("message", (event) => render(event.data));
  vscode.postMessage({ type: "ready" });
})();
