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

  const SEVERITY_ICONS = { error: "error", warning: "warning", info: "info", ok: "pass" };
  const PROBLEM_ICONS = { mainConflict: "error", overlapWithMe: "warning", team: "warning" };

  /** @param {any} model */
  function render(model) {
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
      for (const p of model.problems) {
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
        list.append(item);
      }
      root.append(list);
    }

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
