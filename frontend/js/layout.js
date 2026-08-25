// Shared header/footer HTML injection so pages stay DRY.

export function renderHeader() {
  const host = document.getElementById("site-header");
  if (!host) return;
  host.innerHTML = `
    <a class="brand" href="index.html">
      <span class="wordmark">Legacy<span>Vault</span></span>
    </a>
    <nav class="main-nav">
      <a data-nav="home" href="index.html">How It Works</a>
      <a data-nav="dashboard" href="vaults.html">My Vaults</a>
      <a data-nav="create" href="create.html">Create Vault</a>
      <a data-nav="claims" href="claims.html">Claimable Assets</a>
    </nav>
    <div class="wallet-zone" id="wallet-zone"></div>
  `;

  const footer = document.querySelector(".footer-note");
  if (footer && !footer.dataset.done) {
    footer.dataset.done = "1";
    footer.innerHTML = `
      <span>Legacy Vault — a dead man's switch for BOT Chain. Immutable by design.</span>
      <span><a href="watch.html">public vault watch ↗</a></span>
    `;
  }
}
