// Shared header/footer HTML injection so pages stay DRY.

export function renderHeader() {
  const host = document.getElementById("site-header");
  if (!host) return;
  host.innerHTML = `
    <a class="brand" href="index.html">
      <span class="wordmark">Legacy<span>Vault</span></span>
    </a>
    <button class="nav-toggle" id="nav-toggle" aria-label="Menu" aria-expanded="false">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M3 6h18M3 12h18M3 18h18"/>
      </svg>
    </button>
    <nav class="main-nav" id="main-nav">
      <a data-nav="home" href="index.html">How It Works</a>
      <a data-nav="dashboard" href="vaults.html">My Vaults</a>
      <a data-nav="create" href="create.html">Create Vault</a>
      <a data-nav="claims" href="claims.html">Claimable Assets</a>
    </nav>
    <div class="wallet-zone" id="wallet-zone"></div>
  `;

  const toggle = document.getElementById("nav-toggle");
  const nav = document.getElementById("main-nav");
  toggle?.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  // close the panel after navigating
  nav?.addEventListener("click", (e) => {
    if (e.target.closest("a")) {
      nav.classList.remove("open");
      toggle?.setAttribute("aria-expanded", "false");
    }
  });

  const footer = document.querySelector(".footer-note");
  if (footer && !footer.dataset.done) {
    footer.dataset.done = "1";
    footer.innerHTML = `
      <span>Legacy Vault — a dead man's switch for BOT Chain. Immutable by design.</span>
      <span><a href="watch.html">public vault watch ↗</a></span>
    `;
  }
}
