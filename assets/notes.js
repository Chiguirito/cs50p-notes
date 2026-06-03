/* CS50P interactive lecture notes — shared engine. Plain JS, no build step.
   Runs Python in the browser via Pyodide (loaded from CDN on first use). */
(function () {
  "use strict";

  var PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.27.2/full/";
  var pyReadyPromise = null;
  var pyWarm = false;
  var activeOut = null;    // appends to the running cell's output (and input echo)
  var activeStatus = null; // sets the running cell's status text

  /* ---------- Pyodide loading ---------- */
  function injectScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = src; s.onload = res;
      s.onerror = function () { rej(new Error("Could not load " + src)); };
      document.head.appendChild(s);
    });
  }
  function loadPy() {
    if (pyReadyPromise) return pyReadyPromise;
    pyReadyPromise = (async function () {
      await injectScript(PYODIDE_URL + "pyodide.js");
      var py = await loadPyodide({ indexURL: PYODIDE_URL });
      // input(): show the REAL prompt, signal we're waiting, and echo the typed
      // value into the cell output on its own line (terminal-style). Cancelling
      // the prompt returns null -> the Python shim raises EOFError (like Ctrl-D),
      // instead of silently feeding "" into the program.
      globalThis.__cs50pInput = function (promptText) {
        if (typeof activeStatus === "function") activeStatus("⌨ Waiting for your input — see the pop-up…");
        var v = window.prompt((promptText && promptText.trim()) ? promptText : "Enter a value:");
        if (typeof activeStatus === "function") activeStatus("Running…");
        if (v === null) {
          if (typeof activeOut === "function") activeOut((promptText || "") + "\n");
          return null;
        }
        if (typeof activeOut === "function") activeOut((promptText || "") + v + "\n");
        return v;
      };
      await py.runPythonAsync(
        "import builtins, js\n" +
        "def input(prompt=''):\n" +
        "    v = js.__cs50pInput(str(prompt))\n" +
        "    if v is None:\n" +
        "        raise EOFError('input was cancelled')\n" +
        "    return v\n" +
        "builtins.input = input\n"
      );
      pyWarm = true;
      return py;
    })().catch(function (e) { pyReadyPromise = null; throw e; }); // allow retry on failure
    return pyReadyPromise;
  }

  function cleanTrace(msg) {
    if (!msg) return "An error occurred.";
    var i = msg.lastIndexOf("Traceback (most recent call last)");
    var lines = (i >= 0 ? msg.slice(i) : msg).split("\n");
    // Drop Pyodide's own internal frames so only the learner's code + error show.
    var out = [], skipping = false;
    for (var k = 0; k < lines.length; k++) {
      var l = lines[k];
      if (/^\s*File "/.test(l)) {                 // a frame header
        skipping = /_pyodide|\/lib\/python/.test(l);
        if (!skipping) out.push(l);
      } else if (l.length && !/^\s/.test(l)) {    // header or final "SomeError: ..." line
        skipping = false; out.push(l);
      } else if (!skipping) {
        out.push(l);                              // source/caret line of a kept frame
      }
    }
    return out.join("\n").replace(/\n{2,}/g, "\n").trim();
  }

  /* ---------- live code cells ---------- */
  function autoSize(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.max(ta.scrollHeight, 40) + "px";
  }
  function tabHandler(e) {
    if (e.key === "Escape") { this.blur(); return; }  // escape hatch (no keyboard trap)
    if (e.key !== "Tab") return;
    e.preventDefault();
    var s = this.selectionStart, en = this.selectionEnd;
    this.value = this.value.slice(0, s) + "    " + this.value.slice(en);
    this.selectionStart = this.selectionEnd = s + 4;
    autoSize(this);
  }
  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text); } catch (_) {}
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = "✓ Copied";
    if (btn._t) clearTimeout(btn._t);
    btn._t = setTimeout(function () { btn.textContent = btn.dataset.label; }, 1500);
  }

  function resetCell(cell) {
    if (cell.dataset.running === "1") return;   // don't reset mid-run (output would desync)
    var ta = cell.querySelector(".cell-code");
    ta.value = ta.dataset.orig; autoSize(ta);
    var out = cell.querySelector(".cell-out");
    out.textContent = ""; out.className = "cell-out";
    cell.querySelector(".status").textContent = "";
  }

  async function runCell(cell) {
    if (cell.dataset.running === "1") return;   // already running
    var ta = cell.querySelector(".cell-code");
    var out = cell.querySelector(".cell-out");
    var runBtn = cell.querySelector(".run");
    var status = cell.querySelector(".status");
    out.textContent = ""; out.classList.remove("stale"); out.classList.add("show");
    runBtn.disabled = true;
    cell.dataset.running = "1";
    status.textContent = pyWarm ? "Running…" : "Loading Python… (one-time, ~10s)";
    var py;
    try {
      py = await loadPy();
    } catch (e) {
      out.innerHTML = '<span class="err">Couldn\'t load Python. Make sure you\'re online — Python downloads once from the web on first run, then works offline afterwards. If it still won\'t load, start the local server instead: in a terminal, run <code>python3 -m http.server</code> inside the <code>lectures/</code> folder.</span>';
      status.textContent = "✗ couldn't load Python";
      cell.dataset.running = "";
      runBtn.disabled = false;
      return;
    }
    try {
      var buf = "";
      // batched stdout gives us one line at a time WITHOUT its trailing newline,
      // so we re-add it; trim a single trailing newline when displaying.
      var render = function () { out.textContent = buf.replace(/\n$/, ""); };
      var append = function (s) { buf += s; render(); };  // raw append (input echo uses this)
      activeOut = append;
      activeStatus = function (t) { status.textContent = t; };
      py.setStdout({ batched: function (s) { append(s + "\n"); } });
      py.setStderr({ batched: function (s) { append(s + "\n"); } });
      status.textContent = "Running…";
      // Run each cell in a FRESH namespace so cells don't leak names into one
      // another — every cell behaves like its own little program (and like
      // re-typing it into a real .py file). builtins (print/input/…) are shared.
      var ns = py.toPy({});
      try {
        await py.runPythonAsync(ta.value, { globals: ns });
      } finally {
        ns.destroy();
      }
      status.textContent = "✓ done";
    } catch (e) {
      var span = document.createElement("span");
      span.className = "err";
      span.textContent = (out.textContent ? "\n" : "") + cleanTrace(e && e.message ? e.message : String(e));
      out.appendChild(span);
      status.textContent = "✗ error";
    } finally {
      activeOut = null;
      activeStatus = null;
      cell.dataset.running = "";
      runBtn.disabled = false;
    }
  }

  function upgradeCell(ta) {
    var orig = ta.value;
    var cell = document.createElement("div"); cell.className = "cell";
    var shell = document.createElement("div"); shell.className = "cell-shell";
    ta.className = "cell-code"; ta.spellcheck = false; ta.wrap = "off";
    ta.setAttribute("autocapitalize", "off");
    ta.setAttribute("autocorrect", "off");
    ta.setAttribute("aria-label", "Editable Python code. Press Cmd or Ctrl + Enter to run, Escape to leave the editor.");
    var bar = document.createElement("div"); bar.className = "cell-bar";
    bar.innerHTML =
      '<button class="run" type="button">▶ Run</button>' +
      '<button class="reset" type="button">↺ Reset</button>' +
      '<button class="copy" type="button">⧉ Copy</button>' +
      '<span class="status"></span>';
    var out = document.createElement("pre"); out.className = "cell-out";
    out.setAttribute("aria-live", "polite");
    ta.parentNode.insertBefore(cell, ta);
    shell.appendChild(ta); shell.appendChild(bar); shell.appendChild(out);
    cell.appendChild(shell);

    ta.dataset.orig = orig;
    autoSize(ta);
    ta.addEventListener("input", function () {
      autoSize(ta);
      if (out.textContent) out.classList.add("stale");  // output no longer matches edited code
    });
    ta.addEventListener("keydown", tabHandler);
    // Cmd/Ctrl+Enter runs the cell (notebook/REPL gesture)
    ta.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); runCell(cell); }
    });
    // warm Pyodide the first time a learner focuses any cell
    ta.addEventListener("focus", function () { loadPy().catch(function () {}); }, { once: true });
    bar.querySelector(".run").addEventListener("click", function () { runCell(cell); });
    bar.querySelector(".reset").addEventListener("click", function () { resetCell(cell); });
    bar.querySelector(".copy").addEventListener("click", function () { copyText(ta.value, bar.querySelector(".copy")); });
  }

  /* ---------- static (non-runnable) code blocks ---------- */
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function tintComments(src) {
    return escapeHtml(src).split("\n").map(function (line) {
      var i = line.indexOf("#");
      return i >= 0 ? line.slice(0, i) + '<span class="cmt">' + line.slice(i) + "</span>" : line;
    }).join("\n");
  }
  function upgradeStatic(cb) {
    var code = cb.querySelector("code");
    if (code) code.innerHTML = tintComments(code.textContent);
    var btn = document.createElement("button");
    btn.className = "copy-btn"; btn.type = "button"; btn.textContent = "⧉ Copy";
    btn.addEventListener("click", function () { copyText(code ? code.textContent : "", btn); });
    cb.appendChild(btn);
  }

  /* ---------- quizzes ---------- */
  function wireQuiz(quiz) {
    var opts = [].slice.call(quiz.querySelectorAll(".opt"));
    var why = quiz.querySelector(".why");
    opts.forEach(function (opt) {
      opt.addEventListener("click", function () {
        if (quiz.dataset.done) return;
        quiz.dataset.done = "1";
        var correct = opt.hasAttribute("data-correct");
        opt.classList.add(correct ? "correct" : "wrong");
        if (!correct) opts.forEach(function (o) { if (o.hasAttribute("data-correct")) o.classList.add("correct"); });
        opts.forEach(function (o) { o.disabled = true; });
        if (why) { why.classList.add("show"); if (correct) why.classList.add("ok"); }
      });
    });
  }

  /* ---------- TOC, scrollspy, progress ---------- */
  function slug(t) {
    return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
  }
  function buildToc() {
    var main = document.querySelector("main");
    var nav = document.querySelector("nav.toc ol");
    if (!main || !nav) return;
    var heads = [].slice.call(main.querySelectorAll("h2, h3"));
    var links = [];
    heads.forEach(function (h) {
      if (!h.id) h.id = slug(h.textContent);
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "#" + h.id; a.textContent = h.textContent;
      if (h.tagName === "H3") { a.style.paddingLeft = "1.5rem"; a.style.fontSize = ".85rem"; }
      // on narrow screens, collapse the TOC <details> after picking a link
      a.addEventListener("click", function () {
        var d = a.closest("details");
        if (d && window.matchMedia("(max-width: 1079px)").matches) d.open = false;
      });
      li.appendChild(a); nav.appendChild(li); links.push(a);
    });
    if ("IntersectionObserver" in window) {
      var byId = {};
      links.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            links.forEach(function (a) { a.classList.remove("active"); });
            var a = byId[en.target.id]; if (a) a.classList.add("active");
          }
        });
      }, { rootMargin: "-10% 0px -75% 0px" });
      heads.forEach(function (h) { io.observe(h); });
    }
  }
  function wireProgress() {
    var bar = document.getElementById("progress");
    if (!bar) return;
    var tick = function () {
      var h = document.documentElement;
      var max = h.scrollHeight - h.clientHeight;
      bar.style.width = (max > 0 ? (h.scrollTop / max) * 100 : 0) + "%";
    };
    document.addEventListener("scroll", function () { requestAnimationFrame(tick); }, { passive: true });
    tick();
  }

  /* ---------- theme toggle (initial theme set inline in <head>) ---------- */
  function wireTheme() {
    var btn = document.querySelector(".theme-toggle");
    function cur() {
      return document.documentElement.getAttribute("data-theme") ||
        (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    }
    function set(t) {
      document.documentElement.setAttribute("data-theme", t);
      try { localStorage.setItem("cs50p-theme", t); } catch (_) {}
      if (btn) { btn.textContent = t === "dark" ? "☀ Light" : "🌙 Dark"; btn.setAttribute("aria-pressed", t === "dark"); }
    }
    if (btn) { set(cur()); btn.addEventListener("click", function () { set(cur() === "dark" ? "light" : "dark"); }); }
  }

  /* ---------- init ---------- */
  function init() {
    [].slice.call(document.querySelectorAll("textarea.py")).forEach(upgradeCell);
    [].slice.call(document.querySelectorAll(".codeblock")).forEach(upgradeStatic);
    [].slice.call(document.querySelectorAll(".quiz")).forEach(wireQuiz);
    buildToc();
    wireProgress();
    wireTheme();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else { init(); }
})();
