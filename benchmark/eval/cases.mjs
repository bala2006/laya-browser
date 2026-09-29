/**
 * Step-scored evaluation cases for the on-device decision model.
 *
 * Each case is a small page (served locally), a natural-language goal, and the ORACLE
 * trajectory: the correct step at every state. The runner asks the model at each state, scores
 * its answer against the oracle step, then executes the ORACLE step (teacher forcing) so every
 * step is scored from a correct history.
 *
 * Step fields:
 *   op       expected operation (CLICK | TYPE_TEXT | SELECT | SCROLL_DOWN | WAIT | DONE | BLOCKED)
 *   target   expected control name (case-insensitive exact match) for targeted ops
 *   value    text to type / option to select when the oracle step executes (and, for SELECT,
 *            the option the model must pick)
 *   alt      other acceptable ops for this state, e.g. SCROLL_DOWN vs CLICK on a below-fold control
 *   sel      CSS selector the oracle uses to execute the step
 *   after    ms to wait after executing (for loading states)
 *   ruleOwned the production rule layer owns this step (e.g. secrets); reported, not scored
 *
 * Page types mirror the web-agent model card's synthetic set, plus crowded pages that stress
 * the candidate shortlist on real-site scale.
 */

const page = (title, body, script = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
  `<style>body{font-family:sans-serif;max-width:900px;margin:20px auto}label{display:block;margin-top:8px}</style>` +
  `</head><body>${body}<script>${script}</script></body></html>`;

const say = (id, text) => `document.getElementById(${JSON.stringify(id)}).textContent=${text};`;

const links = (items) => items.map((t, i) => `<li><a href="/item.html?i=${i}">${t}</a></li>`).join("");

const PRODUCTS = [
  "Garmin Forerunner 55", "Garmin Forerunner 165", "Garmin Venu 3", "Garmin Fenix 7", "Polar Pacer",
  "Polar Vantage V3", "Suunto Race", "Suunto 9 Peak", "Coros Pace 3", "Coros Apex 2", "Apple Watch SE",
  "Apple Watch Series 10", "Apple Watch Ultra 2", "Samsung Galaxy Watch 7", "Samsung Galaxy Watch Ultra",
  "Fitbit Charge 6", "Fitbit Versa 4", "Fitbit Sense 2", "Amazfit Balance", "Amazfit T-Rex 3",
  "Amazfit Bip 5", "Withings ScanWatch 2", "Withings Steel HR", "Google Pixel Watch 3", "Huawei Watch GT 5",
  "Huawei Watch Fit 3", "Xiaomi Smart Band 9", "Whoop 4.0", "Oura Ring 4", "Casio G-Shock GBD-H2000",
];
const NAV = [
  "Home", "Deals", "New arrivals", "Brands", "Running", "Cycling", "Swimming", "Hiking", "Smartwatches",
  "Fitness trackers", "Heart rate monitors", "Accessories", "Straps", "Chargers", "Screen protectors",
  "Gift cards", "Help", "Returns", "Shipping", "Track order", "Stores", "Careers", "Press", "Blog", "Sign in",
];

export const CASES = [
  {
    id: "search",
    goal: 'Search for "laptops"',
    pages: {
      "/": page("Search", `<h1>Search</h1><form onsubmit="run();return false"><input id="q" type="search" aria-label="Search"><button>Go</button></form><p id="r"></p>`,
        `function run(){${say("r", '"Showing results for "+q.value')}}`),
    },
    steps: [
      { op: "TYPE_TEXT", target: "Search", value: "laptops", sel: "#q" },
      { op: "CLICK", target: "Go", sel: "button" },
      { op: "DONE" },
    ],
  },
  {
    id: "login",
    goal: "Sign in as ada@example.com with password s3cret and the admin role",
    pages: {
      "/": page("Sign in", `<h1>Sign in</h1><form onsubmit="go();return false">
        <label for="e">Email</label><input id="e" type="email">
        <label for="p">Password</label><input id="p" type="password">
        <label for="r">Role</label><select id="r"><option value="">Choose a role</option><option>user</option><option>admin</option></select>
        <button id="s">Sign in</button></form><p id="st"></p>`,
        `function go(){${say("st", '"Signed in as "+e.value+" ("+r.value+")"')}document.title="Signed in"}`),
    },
    steps: [
      { op: "TYPE_TEXT", target: "Email", value: "ada@example.com", sel: "#e" },
      { op: "TYPE_TEXT", target: "Password", value: "s3cret", sel: "#p", ruleOwned: true },
      { op: "SELECT", target: "Role", value: "admin", sel: "#r" },
      { op: "CLICK", target: "Sign in", sel: "#s" },
      { op: "DONE" },
    ],
  },
  {
    id: "signup",
    goal: "Create an account for Grace Hopper with email grace@example.com and accept the terms",
    pages: {
      "/": page("Sign up", `<h1>Create account</h1><form onsubmit="go();return false">
        <label for="n">Full name</label><input id="n">
        <label for="m">Email</label><input id="m" type="email">
        <label><input id="t" type="checkbox"> I agree to the terms</label>
        <button id="c">Create account</button></form><p id="st"></p>`,
        `function go(){${say("st", 't.checked?"Account created for "+n.value:"Please accept the terms"')}}`),
    },
    steps: [
      { op: "TYPE_TEXT", target: "Full name", value: "Grace Hopper", sel: "#n" },
      { op: "TYPE_TEXT", target: "Email", value: "grace@example.com", sel: "#m" },
      { op: "CLICK", target: "I agree to the terms", sel: "#t" },
      { op: "CLICK", target: "Create account", sel: "#c" },
      { op: "DONE" },
    ],
  },
  {
    id: "filters",
    goal: "Show only in-stock items with free shipping",
    pages: {
      "/": page("Shop", `<h1>Tents</h1><fieldset><legend>Filters</legend>
        <label><input type="checkbox" id="a"> In stock</label>
        <label><input type="checkbox" id="b"> Free shipping</label>
        <label><input type="checkbox" id="c"> 4 stars &amp; up</label>
        <button id="ap">Apply filters</button></fieldset><p id="st">Showing 48 tents</p>`,
        `ap.onclick=()=>{${say("st", '"Showing "+(a.checked&&b.checked?"7":"20")+" tents (filters applied)"')}}`),
    },
    steps: [
      { op: "CLICK", target: "In stock", sel: "#a" },
      { op: "CLICK", target: "Free shipping", sel: "#b" },
      { op: "CLICK", target: "Apply filters", sel: "#ap" },
      { op: "DONE" },
    ],
  },
  {
    id: "dropdown",
    goal: "Set the country to Canada and save",
    pages: {
      "/": page("Profile", `<h1>Profile</h1><label for="c">Country</label><select id="c"><option>United States</option><option>Canada</option><option>Mexico</option></select>
        <button id="s">Save</button><p id="st"></p>`, `s.onclick=()=>{${say("st", '"Saved: "+c.value')}}`),
    },
    steps: [
      { op: "SELECT", target: "Country", value: "Canada", sel: "#c" },
      { op: "CLICK", target: "Save", sel: "#s" },
      { op: "DONE" },
    ],
  },
  {
    id: "radio",
    goal: "Choose Express shipping and continue",
    pages: {
      "/": page("Shipping", `<h1>Shipping speed</h1>
        <label><input type="radio" name="s" id="st" checked> Standard</label>
        <label><input type="radio" name="s" id="ex"> Express</label>
        <label><input type="radio" name="s" id="ov"> Overnight</label>
        <button id="c">Continue</button><p id="o"></p>`, `c.onclick=()=>{${say("o", 'ex.checked?"Express selected, continuing to payment":"Standard"')}}`),
    },
    steps: [
      { op: "CLICK", target: "Express", sel: "#ex" },
      { op: "CLICK", target: "Continue", sel: "#c" },
      { op: "DONE" },
    ],
  },
  {
    id: "wizard",
    goal: "Register the company Acme with a team size of 11-50",
    pages: {
      "/": page("Register - step 1", `<h1>Step 1 of 2</h1><label for="n">Company name</label><input id="n">
        <button id="nx" onclick="location.href='/step2.html'">Next</button>`),
      "/step2.html": page("Register - step 2", `<h1>Step 2 of 2</h1><label for="t">Team size</label><select id="t"><option>1-10</option><option>11-50</option><option>51-200</option></select>
        <button id="f">Finish</button><p id="st"></p>`, `f.onclick=()=>{${say("st", '"Registration complete"')}}`),
    },
    steps: [
      { op: "TYPE_TEXT", target: "Company name", value: "Acme", sel: "#n" },
      { op: "CLICK", target: "Next", sel: "#nx", after: 300 },
      { op: "SELECT", target: "Team size", value: "11-50", sel: "#t" },
      { op: "CLICK", target: "Finish", sel: "#f" },
      { op: "DONE" },
    ],
  },
  {
    id: "autocomplete",
    goal: "Set the destination city to Lisbon",
    pages: {
      "/": page("Trip", `<h1>Where to?</h1><label for="c">Destination city</label>
        <input id="c" role="combobox" aria-controls="lb" aria-expanded="false" autocomplete="off">
        <ul id="lb" role="listbox"></ul><p id="st"></p>`,
        `const all=["Lisbon, Portugal","Lima, Peru","Lille, France","Linz, Austria"];
         c.oninput=()=>{lb.innerHTML="";c.setAttribute("aria-expanded","true");
           all.filter(x=>x.toLowerCase().startsWith(c.value.toLowerCase().slice(0,2))).forEach(x=>{const li=document.createElement("li");
           li.setAttribute("role","option");li.textContent=x;li.onclick=()=>{c.value=x;lb.innerHTML="";c.setAttribute("aria-expanded","false");${say("st", '"Destination: "+x')}};lb.appendChild(li)})};`),
    },
    steps: [
      { op: "TYPE_TEXT", target: "Destination city", value: "Lis", sel: "#c", after: 150 },
      { op: "CLICK", target: "Lisbon, Portugal", sel: "#lb li:first-child" },
      { op: "DONE" },
    ],
  },
  {
    id: "cart",
    goal: "Buy 2 Blue mugs",
    pages: {
      "/": page("Cart", `<h1>Your cart</h1>
        <div>Blue mug <label>Quantity for Blue mug<input id="q1" type="number" value="1"></label> <button>Remove Blue mug</button></div>
        <div>Red plate <label>Quantity for Red plate<input id="q2" type="number" value="1"></label> <button>Remove Red plate</button></div>
        <button id="co">Checkout</button><p id="st"></p>`, `co.onclick=()=>{${say("st", '"Order placed: "+q1.value+" Blue mug"')}}`),
    },
    steps: [
      { op: "TYPE_TEXT", target: "Quantity for Blue mug", value: "2", sel: "#q1" },
      { op: "CLICK", target: "Checkout", sel: "#co" },
      { op: "DONE" },
    ],
  },
  {
    id: "completed",
    goal: "Place the order",
    pages: {
      "/": page("Order confirmed", `<h1>Thank you!</h1><p>Your order has been placed. Order number 10442.</p><a href="/">Home</a> <a href="/">Your orders</a>`),
    },
    steps: [{ op: "DONE" }],
  },
  {
    id: "impossible",
    goal: "Book a flight to Tokyo",
    pages: {
      "/": page("Pasta recipes", `<h1>Easy pasta recipes</h1><p>Boil water, add salt, cook the pasta for 9 minutes.</p><a href="/">Next recipe</a> <button>Print recipe</button>`),
    },
    steps: [{ op: "BLOCKED" }],
  },
  {
    id: "long-page",
    goal: "Subscribe to the newsletter",
    pages: {
      "/": page("Article", `<h1>The history of tea</h1>${"<p>Tea has been enjoyed for thousands of years across many cultures and climates. </p>".repeat(60)}
        <button id="sub">Subscribe to our newsletter</button><p id="st"></p>`, `sub.onclick=()=>{${say("st", '"Subscribed!"')}}`),
    },
    steps: [
      { op: "SCROLL_DOWN", alt: ["CLICK"], altTarget: "Subscribe to our newsletter", sel: "@scroll" },
      { op: "SCROLL_DOWN", alt: ["CLICK"], altTarget: "Subscribe to our newsletter", sel: "@scroll" },
      { op: "SCROLL_DOWN", alt: ["CLICK"], altTarget: "Subscribe to our newsletter", sel: "@scroll" },
      { op: "CLICK", target: "Subscribe to our newsletter", sel: "#sub" },
      { op: "DONE" },
    ],
  },
  {
    id: "crowded-links",
    goal: "Open the Garmin Fenix 7 product page",
    pages: {
      "/": page("Watch store", `<nav><ul>${NAV.map((n) => `<li><a href="/">${n}</a></li>`).join("")}</ul></nav>
        <h1>All watches</h1><ul>${links(PRODUCTS)}</ul>`),
      "/item.html": page("Product", `<h1 id="h"></h1><button>Add to cart</button>`,
        `h.textContent=${JSON.stringify(PRODUCTS)}[+new URLSearchParams(location.search).get("i")];document.title=h.textContent`),
    },
    steps: [
      { op: "CLICK", target: "Garmin Fenix 7", sel: "text=Garmin Fenix 7", after: 300 },
      { op: "DONE" },
    ],
  },
  {
    id: "crowded-form",
    goal: 'Change the display name to "Neo" and save',
    pages: {
      "/": page("Settings", `<h1>Account settings</h1>${[
        "First name", "Last name", "Phone", "Street", "City", "Postcode", "Region", "Company", "Job title",
        "Website", "Twitter", "GitHub", "LinkedIn", "Bio", "Timezone", "Language", "Currency", "Recovery email",
        "Backup phone", "Nickname", "Pronouns", "Display name", "Signature",
      ].map((f, i) => `<label for="f${i}">${f}</label><input id="f${i}">`).join("")}<button id="sv">Save changes</button><p id="st"></p>`,
        `sv.onclick=()=>{${say("st", '"Saved"')}}`),
    },
    steps: [
      { op: "TYPE_TEXT", target: "Display name", value: "Neo", sel: "#f21" },
      { op: "CLICK", target: "Save changes", sel: "#sv" },
      { op: "DONE" },
    ],
  },
  {
    id: "navigation",
    goal: "Go to the pricing page",
    pages: {
      "/": page("Acme", `<nav><a href="/about.html">About</a> <a href="/pricing.html">Pricing</a> <a href="/about.html">Contact</a> <a href="/about.html">Blog</a></nav><h1>Acme builds rockets</h1>`),
      "/pricing.html": page("Pricing - Acme", `<h1>Pricing</h1><p>Starter $9/month. Pro $29/month.</p><a href="/">Home</a>`),
      "/about.html": page("About - Acme", `<h1>About</h1>`),
    },
    steps: [
      { op: "CLICK", target: "Pricing", sel: "text=Pricing", after: 300 },
      { op: "DONE" },
    ],
  },
  {
    id: "contact",
    goal: 'Send support the message "My order is late" from Sam, sam@example.com',
    pages: {
      "/": page("Contact", `<h1>Contact support</h1><label for="n">Name</label><input id="n"><label for="e">Email</label><input id="e" type="email">
        <label for="m">Message</label><textarea id="m"></textarea><button id="s">Send message</button><p id="st"></p>`,
        `s.onclick=()=>{${say("st", '"Thanks "+n.value+", your message was sent"')}}`),
    },
    steps: [
      { op: "TYPE_TEXT", target: "Name", value: "Sam", sel: "#n" },
      { op: "TYPE_TEXT", target: "Email", value: "sam@example.com", sel: "#e" },
      { op: "TYPE_TEXT", target: "Message", value: "My order is late", sel: "#m" },
      { op: "CLICK", target: "Send message", sel: "#s" },
      { op: "DONE" },
    ],
  },
  {
    id: "reservation",
    goal: "Reserve a table for 4 people on 2026-10-12",
    pages: {
      "/": page("Reserve", `<h1>Reserve a table</h1><label for="g">Guests</label><input id="g" type="number">
        <label for="d">Date</label><input id="d" placeholder="YYYY-MM-DD"><button id="r">Reserve</button><p id="st"></p>`,
        `r.onclick=()=>{${say("st", '"Table for "+g.value+" reserved on "+d.value')}}`),
    },
    steps: [
      { op: "TYPE_TEXT", target: "Guests", value: "4", sel: "#g" },
      { op: "TYPE_TEXT", target: "Date", value: "2026-10-12", sel: "#d" },
      { op: "CLICK", target: "Reserve", sel: "#r" },
      { op: "DONE" },
    ],
  },
  {
    id: "results-open",
    goal: "Open the search result about Ada Lovelace",
    pages: {
      "/": page("Results for mathematicians", `<h1>Results</h1><ul>
        <li><a href="/a.html">Alan Turing - Biography</a></li><li><a href="/b.html">Ada Lovelace - Biography</a></li>
        <li><a href="/a.html">Emmy Noether - Biography</a></li><li><a href="/a.html">Carl Gauss - Biography</a></li></ul>`),
      "/b.html": page("Ada Lovelace - Biography", `<h1>Ada Lovelace</h1><p>First computer programmer.</p>`),
      "/a.html": page("Other", `<h1>Other</h1>`),
    },
    steps: [
      { op: "CLICK", target: "Ada Lovelace - Biography", sel: "text=Ada Lovelace - Biography", after: 300 },
      { op: "DONE" },
    ],
  },
  {
    id: "loading",
    goal: 'Search for "tents" and open the first result',
    pages: {
      "/": page("Outdoor shop", `<h1>Outdoor shop</h1><input id="q" type="search" aria-label="Search products"><button id="go">Search</button><div id="res"></div>`,
        `go.onclick=()=>{res.textContent="Loading results...";setTimeout(()=>{res.innerHTML='<a href="/t.html">Trail 2 tent</a> <a href="/t.html">Summit 4 tent</a>'},1200)}`),
      "/t.html": page("Trail 2 tent", `<h1>Trail 2 tent</h1>`),
    },
    steps: [
      { op: "TYPE_TEXT", target: "Search products", value: "tents", sel: "#q" },
      { op: "CLICK", target: "Search", sel: "#go", after: 50 },
      { op: "WAIT", sel: "@wait", after: 1400 },
      { op: "CLICK", target: "Trail 2 tent", sel: "text=Trail 2 tent", after: 300 },
      { op: "DONE" },
    ],
  },
];
