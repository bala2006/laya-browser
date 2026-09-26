/**
 * The benchmark task registry.
 *
 * Each task is a self-contained automation scenario against a local fixture. A task carries:
 *   - id / category / description: identity + grouping for the results table.
 *   - fixture: the path (under the fixture server) the scenario starts on.
 *   - applies: which servers can attempt it (`both`, or a capability the server must have).
 *   - assist(h): the Assist-mode tool script a client LLM would issue. Because laya-browser-mcp
 *       mirrors Playwright MCP arg shapes (`target`, `text`, `values`, `fields`, ...), the SAME
 *       script drives BOTH servers, which is the fairness guarantee.
 *   - autopilot(h): an optional single-call `laya_run_goal` variant (laya only).
 *   - verify(h): a predicate that RE-PROBES the real page (navigate/evaluate) and asserts a
 *       LITERAL DOM/text outcome. It returns true only when the scenario genuinely succeeded.
 *
 * The `h` helper (built in runner.mjs) exposes:
 *   h.base                       loopback fixture base URL
 *   h.call(name, args)           issue one MCP tool call (counts as a round-trip); returns text
 *   h.snapshot()                 fresh browser_snapshot text
 *   h.refFor(text, snapText?)    resolve a [ref=eN] by matching a snapshot line substring
 *   h.evalText(selector)         read textContent of a selector via browser_evaluate
 *   h.evalValue(selector)       read .value of an input via browser_evaluate
 *   h.evalTitle()                read document.title
 */

/** Resolve the first [ref=eN] on a snapshot line containing `needle`. */
function refFrom(snapText, needle) {
  for (const line of snapText.split("\n")) {
    if (line.includes(needle)) {
      const m = line.match(/\[ref=(e\d+)\]/);
      if (m) return m[1];
    }
  }
  return undefined;
}

export { refFrom };

export const TASKS = [
  // --- Navigation ---
  {
    id: "nav-basic",
    category: "navigation",
    description: "Navigate to a page and confirm its title",
    fixture: "/search.html",
    applies: "both",
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/search.html" });
    },
    async verify(h) {
      const title = await h.evalTitle();
      return title === "Search";
    },
  },

  // --- Search form: type + submit ---
  {
    id: "search-type-submit",
    category: "forms",
    description: "Type a query into a search box and submit it",
    fixture: "/search.html",
    applies: "both",
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/search.html" });
      const snap = await h.snapshot();
      const ref = refFrom(snap, 'searchbox "Search"') ?? refFrom(snap, "searchbox") ?? "#q";
      await h.call("browser_type", { target: ref, text: "laptops", element: "Search box", submit: true });
    },
    async autopilot(h) {
      await h.call("laya_run_goal", {
        goal: 'Search for "laptops" and expect "Showing results for laptops"',
        url: h.base + "/search.html",
      });
    },
    async verify(h) {
      const text = await h.evalText("#results");
      return text === "Showing results for laptops";
    },
  },

  // --- Multi-field login: fill_form + select + checkbox + submit ---
  {
    id: "login-fill-form",
    category: "multi-field-form",
    description: "Fill email, password, role select, remember checkbox, then submit",
    fixture: "/login.html",
    applies: "both",
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/login.html" });
      const snap = await h.snapshot();
      const email = refFrom(snap, 'textbox "Email"') ?? "#email";
      const password = refFrom(snap, "Password") ?? "#password";
      const remember = refFrom(snap, "checkbox") ?? "#remember";
      await h.call("browser_fill_form", {
        // Include element/name/type on every field: laya makes name/type optional while
        // Playwright MCP requires them, so the fully-specified shape drives BOTH fairly.
        fields: [
          { target: email, element: "Email field", name: "Email", type: "textbox", value: "ada@example.com" },
          { target: password, element: "Password field", name: "Password", type: "textbox", value: "s3cret" },
          { target: remember, element: "Remember checkbox", name: "Remember me", type: "checkbox", value: "true" },
        ],
      });
      const snap2 = await h.snapshot();
      const role = refFrom(snap2, "combobox") ?? refFrom(snap2, "Role") ?? "#role";
      await h.call("browser_select_option", { target: role, values: ["admin"], element: "Role select" });
      const snap3 = await h.snapshot();
      const submit = refFrom(snap3, 'button "Sign in"') ?? "#submit";
      await h.call("browser_click", { target: submit, element: "Sign in button" });
    },
    async autopilot(h) {
      await h.call("laya_run_goal", {
        goal: 'email is "ada@example.com", password is "s3cret", role is "admin", then sign in and expect "Signed in"',
        url: h.base + "/login.html",
      });
    },
    async verify(h) {
      const status = await h.evalText("#status");
      const role = await h.evalValue("#role");
      return status.startsWith("Signed in ada@example.com") && role === "admin";
    },
  },

  // --- Select option in isolation ---
  {
    id: "select-option",
    category: "selection",
    description: "Choose a value from a dropdown",
    fixture: "/login.html",
    applies: "both",
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/login.html" });
      const snap = await h.snapshot();
      const role = refFrom(snap, "combobox") ?? refFrom(snap, "Role") ?? "#role";
      await h.call("browser_select_option", { target: role, values: ["auditor"], element: "Role select" });
    },
    async verify(h) {
      const role = await h.evalValue("#role");
      return role === "auditor";
    },
  },

  // --- Click a button ---
  {
    id: "click-button",
    category: "click",
    description: "Click a button and confirm its side effect",
    fixture: "/storage.html",
    applies: "both",
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/storage.html" });
      const snap = await h.snapshot();
      const ref = refFrom(snap, "Seed storage") ?? "#seed";
      await h.call("browser_click", { target: ref, element: "Seed button" });
    },
    async verify(h) {
      const status = await h.evalText("#status");
      return status === "Storage seeded";
    },
  },

  // --- Hover reveal ---
  {
    id: "hover-reveal",
    category: "hover",
    description: "Hover an element to reveal hidden content",
    fixture: "/hover.html",
    applies: "both",
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/hover.html" });
      const snap = await h.snapshot();
      const ref = refFrom(snap, "Hover me") ?? "#menu";
      await h.call("browser_hover", { target: ref, element: "Hover menu" });
    },
    async verify(h) {
      const panel = await h.evalText("#panel");
      return panel === "Revealed menu content";
    },
  },

  // --- Wait for dynamic content ---
  {
    id: "wait-for-dynamic",
    category: "wait-for",
    description: "Wait for delayed text to appear after a timeout",
    fixture: "/dynamic.html",
    applies: "both",
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/dynamic.html" });
      await h.call("browser_wait_for", { text: "Job complete" });
    },
    async verify(h) {
      const result = await h.evalText("#result");
      return result === "Job complete";
    },
  },

  // --- Tabs: window.open a second tab ---
  {
    id: "tabs-open",
    category: "tabs",
    description: "Open a second tab via window.open and list tabs",
    fixture: "/tabs.html",
    applies: "both",
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/tabs.html" });
      const snap = await h.snapshot();
      const ref = refFrom(snap, "Open report") ?? "#open";
      await h.call("browser_click", { target: ref, element: "Open report button" });
      await h.call("browser_tabs", { action: "list" });
    },
    async verify(h) {
      const tabs = await h.call("browser_tabs", { action: "list" });
      // Two tabs open: the opener plus the report tab.
      return /report\.html/.test(tabs) || /\(2\)/.test(tabs) || /\[1\]/.test(tabs);
    },
  },

  // --- Dialogs: confirm() ---
  {
    id: "dialog-confirm",
    category: "dialogs",
    description: "Accept a confirm() dialog triggered by a click",
    fixture: "/dialog.html",
    applies: "both",
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/dialog.html" });
      const snap = await h.snapshot();
      const ref = refFrom(snap, "Delete item") ?? "#confirm";
      // laya-browser-mcp pre-arms the NEXT dialog's disposition, then the click fires it.
      // Playwright MCP handles dialogs reactively: the click returns a "modal state" and you
      // resolve it with a follow-up handle_dialog. Support BOTH honestly: pre-arm, click
      // (tolerating a modal-state result), then resolve any still-pending dialog.
      await h.call("browser_handle_dialog", { accept: true }).catch(() => {});
      await h.call("browser_click", { target: ref, element: "Delete button" }).catch(() => {});
      await h.call("browser_handle_dialog", { accept: true }).catch(() => {});
    },
    async verify(h) {
      const status = await h.evalText("#status");
      return status === "Item deleted";
    },
  },

  // --- Console capture ---
  {
    id: "console-capture",
    category: "console",
    description: "Capture a console.log emitted on page load",
    fixture: "/console.html",
    applies: "both",
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/console.html" });
      await h.call("browser_console_messages", {});
    },
    async verify(h) {
      const msgs = await h.call("browser_console_messages", {});
      return msgs.includes("laya-console-marker");
    },
  },

  // --- Network capture ---
  {
    id: "network-capture",
    category: "network",
    description: "Observe a same-origin fetch() request",
    fixture: "/network.html",
    applies: "both",
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/network.html" });
      await h.call("browser_network_requests", {});
    },
    async verify(h) {
      const reqs = await h.call("browser_network_requests", {});
      return reqs.includes("/api/data.json");
    },
  },

  // --- Screenshot ---
  {
    id: "screenshot",
    category: "screenshot",
    description: "Capture a screenshot of the page",
    fixture: "/search.html",
    applies: "both",
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/search.html" });
      const img = await h.callRaw("browser_take_screenshot", { type: "png" });
      h.stash("screenshot", img);
    },
    async verify(h) {
      const img = h.unstash("screenshot");
      // A real image content block with non-trivial base64 bytes.
      return !!img && img.type === "image" && typeof img.data === "string" && img.data.length > 1000;
    },
  },

  // --- Storage / cookies (laya storage capability; Playwright core has no cookie tool) ---
  {
    id: "storage-cookies",
    category: "storage",
    description: "Read a cookie set by the page",
    fixture: "/storage.html",
    applies: { laya: "storage", playwright: false },
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/storage.html" });
      const snap = await h.snapshot();
      const ref = refFrom(snap, "Seed storage") ?? "#seed";
      await h.call("browser_click", { target: ref, element: "Seed button" });
      await h.call("browser_cookie_list", {});
    },
    async verify(h) {
      const cookies = await h.call("browser_cookie_list", {});
      return cookies.includes("laya-session");
    },
  },

  // --- localStorage read (laya storage capability) ---
  {
    id: "storage-localstorage",
    category: "storage",
    description: "Read a localStorage value set by the page",
    fixture: "/storage.html",
    applies: { laya: "storage", playwright: false },
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/storage.html" });
      const snap = await h.snapshot();
      const ref = refFrom(snap, "Seed storage") ?? "#seed";
      await h.call("browser_click", { target: ref, element: "Seed button" });
      await h.call("browser_localstorage_get", { key: "laya-theme" });
    },
    async verify(h) {
      const value = await h.call("browser_localstorage_get", { key: "laya-theme" });
      return value.trim() === "dark";
    },
  },

  // --- Evaluate ---
  {
    id: "evaluate",
    category: "evaluate",
    description: "Evaluate JavaScript against the page",
    fixture: "/search.html",
    applies: "both",
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/search.html" });
      const out = await h.call("browser_evaluate", { function: "() => document.title" });
      h.stash("eval", out);
    },
    async verify(h) {
      const out = h.unstash("eval") ?? "";
      return out.includes("Search");
    },
  },

  // --- Verify/assert (laya testing capability; Playwright core has no verify_* tool) ---
  {
    id: "verify-text",
    category: "verify",
    description: "Assert that expected text is visible on the page",
    fixture: "/search.html",
    applies: { laya: "testing", playwright: false },
    async assist(h) {
      await h.call("browser_navigate", { url: h.base + "/search.html" });
      const snap = await h.snapshot();
      const ref = refFrom(snap, 'searchbox "Search"') ?? refFrom(snap, "searchbox") ?? "#q";
      await h.call("browser_type", { target: ref, text: "cameras", element: "Search box", submit: true });
      const res = await h.call("browser_verify_text_visible", { text: "Showing results for cameras" });
      h.stash("verify", res);
    },
    async verify(h) {
      const res = h.unstash("verify") ?? "";
      const text = await h.evalText("#results");
      return text === "Showing results for cameras" && !/not visible|fail/i.test(res);
    },
  },
];
