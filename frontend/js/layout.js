// Shared header/footer HTML injection so pages stay DRY.

const ICONS = {
  home: `<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/>`,
  dashboard: `<rect x="5" y="5" width="14" height="14" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M12 9V6M12 18v-3"/>`,
  create: `<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>`,
  claims: `<circle cx="9" cy="9" r="5"/><path d="M13.5 6.2A5 5 0 1 1 8.2 13.5"/>`,
};

export function renderHeader() {
  const host = document.getElementById("site-header");
  if (!host) return;
  host.innerHTML = `
    <a class="brand" href="index.html">
      <span class="wordmark">Legacy<span>Vault</span></span>
    </a>
    <nav class="main-nav" id="main-nav">
      ${Object.entries({
        home: ["index.html", "How It Works"],
        dashboard: ["vaults.html", "My Vaults"],
        create: ["create.html", "Create Vault"],
        claims: ["claims.html", "Claimable Assets"],
      })
        .map(
          ([key, [href, label]]) => `
        <a data-nav="${key}" href="${href}">
          <svg class="nav-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>
          <span>${label}</span>
        </a>`
        )
        .join("")}
    </nav>
    <div class="wallet-zone" id="wallet-zone"></div>
  `;

  const footer = document.querySelector(".footer-note");
  if (footer && !footer.dataset.done) {
    footer.dataset.done = "1";
    footer.innerHTML = `
      <span>Legacy Vault: a dead man's switch for BOT Chain. Immutable by design.</span>
      <span><a href="watch.html">public vault watch ↗</a></span>
    `;
  }
}
