// Legacy Vault — shared frontend runtime.
// Wallet layer: zero-dependency EIP-1193 module with EIP-6963 multi-wallet
// discovery, mobile deep links, auto network switch/add, and an account menu
// (copy address, balance, explorer, disconnect). Contract access via ethers v6.

import {
  LV_ABI,
  shortAddr,
  fmtAmt,
  fmtDuration,
  fmtDurationLong,
  humanTime,
  UNIT_SECONDS,
  STATUS_NAMES,
  STATUS_CHIPS,
} from "./helpers.js";

const CFG = window.LV_CONFIG;

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

export const state = {
  address: null,
  chainId: null,
  balance: null, // wei as BigInt
  walletName: null, // active provider label
  provider: null, // raw EIP-1193 provider (active)
};

const listeners = [];

/* ------------------------------------------------------------------ */
/* Chains                                                              */
/* ------------------------------------------------------------------ */

function toHexChainId(id) {
  return "0x" + Number(id).toString(16);
}

/** Chain ids that have a vault address configured, in config order. */
function supportedChainIds() {
  const byChain = CFG.VAULT_ADDRESS_BY_CHAIN ?? {};
  return Object.keys(CFG.CHAINS).filter((id) => byChain[id]);
}

/** First configured chain — the one we nudge users onto. */
function preferredChain() {
  const ids = supportedChainIds();
  if (!ids.length) return null;
  const id = ids[0];
  return { id, ...CFG.CHAINS[id] };
}

function chainParams(id) {
  const c = CFG.CHAINS[String(id)];
  return {
    chainId: toHexChainId(id),
    chainName: c.name,
    nativeCurrency: { name: CFG.TOKEN_SYMBOL || "BOT", symbol: CFG.TOKEN_SYMBOL || "BOT", decimals: 18 },
    rpcUrls: [c.rpc],
    blockExplorerUrls: c.explorer ? [c.explorer] : [],
  };
}

export function isSupportedChain(chainId) {
  return supportedChainIds().includes(String(chainId));
}

/**
 * Make sure the active wallet is on a chain this app supports.
 * Tries wallet_switchEthereumChain first; if the wallet doesn't know the
 * chain it attempts wallet_addEthereumChain, then re-checks.
 */
export async function ensureChain() {
  if (!state.provider) throw new Error("No wallet connected.");
  let current;
  try {
    current = Number(await state.provider.request({ method: "eth_chainId" }));
  } catch {
    current = Number(state.chainId);
  }
  const target = preferredChain();
  if (!target) return current; // nothing configured — leave as-is

  // Already on a supported chain? Leave it alone.
  if (supportedChainIds().includes(String(current))) return current;

  try {
    await state.provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: toHexChainId(target.id) }],
    });
  } catch (err) {
    const code = err?.code ?? err?.data?.originalError?.code;
    // 4902 = chain not added; some wallets throw -32603 for the same thing
    if (code === 4902 || code === -32603) {
      try {
        await state.provider.request({
          method: "wallet_addEthereumChain",
          params: [chainParams(target.id)],
        });
        // Some wallets add but don't switch — try once more.
        await state.provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: toHexChainId(target.id) }],
        }).catch(() => {});
      } catch (addErr) {
        if (addErr?.code !== 4001) toast(`Could not add ${target.name}. Add chain ${target.id} manually in your wallet.`, true);
        throw addErr;
      }
    } else {
      if (code !== 4001) toast(`Could not switch network (${err?.message ?? err}).`, true);
      throw err;
    }
  }

  const after = Number(await state.provider.request({ method: "eth_chainId" }));
  state.chainId = String(after);
  emit();
  return after;
}

/* ------------------------------------------------------------------ */
/* Contract access                                                     */
/* ------------------------------------------------------------------ */

function defaultReadRpc() {
  const anyRpc = Object.values(CFG.CHAINS).find((c) => c.rpc);
  return anyRpc?.rpc ?? null;
}

export function vaultAddress() {
  const key = String(state.chainId ?? "");
  return (CFG.VAULT_ADDRESS_BY_CHAIN && CFG.VAULT_ADDRESS_BY_CHAIN[key]) || CFG.VAULT_ADDRESS;
}

export function contractFor(signerOrProvider) {
  const addr = vaultAddress();
  if (!addr || /^0x0+$/.test(addr)) throw new Error("Vault address not configured — edit frontend/js/config.js");
  return new ethers.Contract(addr, LV_ABI, signerOrProvider);
}

/** Read-only contract. Uses the injected wallet only when its network is
 *  supported; otherwise reads through a public RPC so pages still render. */
export function readOnlyContract() {
  if (state.chainId && window.ethereum && isSupportedChain(state.chainId)) {
    return contractFor(new ethers.BrowserProvider(window.ethereum, "any"));
  }
  if (!state.readProvider) {
    const url = defaultReadRpc();
    if (!url) throw new Error("No wallet connected and no public RPC configured.");
    state.readProvider = new ethers.JsonRpcProvider(url);
  }
  return contractFor(state.readProvider);
}

/** Read-write contract; requires a connection and a supported network. */
export async function signerContract() {
  if (!state.address) throw new Error("Connect your wallet first.");
  if (!isSupportedChain(String(await state.provider.request({ method: "eth_chainId" })))) {
    await ensureChain();
  }
  const browser = new ethers.BrowserProvider(state.provider, "any");
  const signer = await browser.getSigner();
  return contractFor(signer);
}

/* ------------------------------------------------------------------ */
/* Wallet discovery (EIP-6963) + injected fallback                     */
/* ------------------------------------------------------------------ */

const wallets = new Map(); // rdns -> { info, provider }

if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e) => {
    const detail = e.detail;
    if (!detail?.info || !detail?.provider) return;
    wallets.set(detail.info.rdns, detail);
  });
}

function requestProviders() {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

function fallbackWallet() {
  if (!window.ethereum) return null;
  const name =
    window.ethereum.isRabby ? "Rabby" :
    window.ethereum.isCoinbaseWallet ? "Coinbase Wallet" :
    window.ethereum.isTrust || window.ethereum.isTrustWallet ? "Trust Wallet" :
    window.ethereum.isOkxWallet ? "OKX Wallet" :
    window.ethereum.isMetaMask ? "MetaMask" : "Browser Wallet";
  return {
    info: { uuid: "injected", name, icon: null, rdns: "injected" },
    provider: window.ethereum,
  };
}

function listWallets() {
  const found = [...wallets.values()];
  if (!found.length) {
    const fb = fallbackWallet();
    if (fb) found.push(fb);
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* Connect / disconnect / reconnect                                    */
/* ------------------------------------------------------------------ */

const LS_WALLET = "lv.wallet.rdns";
const LS_CONNECTED = "lv.connected";

async function activate(detail, { silent = false } = {}) {
  const accounts = await detail.provider.request({
    method: silent ? "eth_accounts" : "eth_requestAccounts",
  });
  const chainId = await detail.provider.request({ method: "eth_chainId" });

  state.address = accounts[0] ?? null;
  state.chainId = String(Number(chainId));
  state.walletName = detail.info.name;
  state.provider = detail.provider;
  state.readProvider = null;
  wireProviderEvents();

  if (state.address) {
    localStorage.setItem(LS_WALLET, detail.info.rdns);
    if (!silent) localStorage.setItem(LS_CONNECTED, "1");
    refreshBalance().catch(() => {});
  }
  emit();
}

let eventsWired = null;
function wireProviderEvents() {
  if (!state.provider?.on || eventsWired === state.provider) return;
  eventsWired = state.provider;
  state.provider.on("accountsChanged", async (accs) => {
    state.address = accs?.[0] ?? null;
    if (!state.address) await disconnect({ quiet: true });
    else refreshBalance().catch(() => {});
    emit();
  });
  state.provider.on("chainChanged", (cid) => {
    state.chainId = String(Number(cid));
    state.readProvider = null;
    emit();
  });
}

export async function refreshBalance() {
  if (!state.address || !state.provider) return;
  const hex = await state.provider.request({
    method: "eth_getBalance",
    params: [state.address, "latest"],
  });
  state.balance = BigInt(hex);
  emit();
}

export async function initWallet() {
  requestProviders();
  // give announcements a tick to arrive
  await new Promise((r) => setTimeout(r, 60));

  const savedRdns = localStorage.getItem(LS_WALLET);
  const wantsAuto = localStorage.getItem(LS_CONNECTED) === "1";
  const detail = (savedRdns && wallets.get(savedRdns)) || fallbackWallet();

  if (detail && wantsAuto) {
    try {
      await activate(detail, { silent: true });
      if (state.address && !isSupportedChain(state.chainId)) {
        ensureChain().catch(() => {}); // background fix-up, never blocks page load
      }
    } catch {}
  } else if (detail) {
    // not connecting, but still track chain changes from a previously
    // authorized provider so the UI can react
    try {
      const cid = await detail.provider.request({ method: "eth_chainId" });
      state.chainId = String(Number(cid));
    } catch {}
    state.provider = detail.provider;
    wireProviderEvents();
  }
  emit();
}

export function connect(rdns = null) {
  if (rdns) {
    const detail = wallets.get(rdns);
    if (!detail) {
      toast("That wallet is no longer available.", true);
      return Promise.resolve();
    }
    return activate(detail)
      .then(() => {
        toast(`Connected via ${state.walletName}`);
        return ensureChain().catch(() => {});
      })
      .catch((err) => {
        if (err?.code !== 4001) toast(`Connection failed: ${cleanErr(err)}`, true);
      });
  }
  openConnectModal();
  return Promise.resolve();
}

export async function disconnect({ quiet = false } = {}) {
  localStorage.removeItem(LS_CONNECTED);
  localStorage.removeItem(LS_WALLET);
  try {
    // Best-effort logout so eth_accounts stays empty next visit.
    await state.provider?.request?.({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch {}
  state.address = null;
  state.balance = null;
  state.walletName = null;
  state.readProvider = null;
  if (!quiet) emit();
}

export function isConnected() {
  return !!state.address;
}

export function onWalletChange(cb) {
  listeners.push(cb);
  cb(); // initial render
}
function emit() {
  listeners.forEach((cb) => {
    try {
      cb();
    } catch {}
  });
}

/* ------------------------------------------------------------------ */
/* Connect modal                                                       */
/* ------------------------------------------------------------------ */

function currentPathUrl() {
  return `${location.host}${location.pathname}${location.search}`;
}

/** Official universal links that open this page inside each wallet's browser.
 *  Navigated in the SAME tab so the redirect chain to the app can complete. */
function deepLinks() {
  const enc = encodeURIComponent(`https://${currentPathUrl()}`);
  return [
    { name: "MetaMask", href: `https://metamask.app.link/dapp/${currentPathUrl()}` },
    { name: "Trust Wallet", href: `https://link.trustwallet.com/open_url?url=${enc}` },
    { name: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${enc}` },
    { name: "OKX Wallet", href: `https://www.okx.com/download?deeplink=${enc}` },
  ];
}

/** Heuristic: are we already inside a wallet's built-in browser? */
function inWalletBrowser() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /MetaMaskMobile|Trust|CoinbaseWallet|OKX|OKApp|Rabby/i.test(ua) && !!window.ethereum;
}

const GENERIC_ICON = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#1faa6e" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M9 10.5a3 3 0 1 1 4.2 2.75c-.75.33-1.2.95-1.2 1.75v.5"/><circle cx="12" cy="18" r=".6" fill="#1faa6e"/></svg>`;

export function openConnectModal() {
  closeModal();
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.id = "connect-modal";

  const options = listWallets();
  const inApp = inWalletBrowser();

  const installedRows = options.length
    ? options
        .map(
          (w) => `
      <button class="wallet-option" data-rdns="${w.info.rdns}">
        ${w.info.icon ? `<img src="${w.info.icon}" alt="" />` : GENERIC_ICON}
        <span>${w.info.name}</span>
        <span class="chev">→</span>
      </button>`
        )
        .join("")
    : `<p class="modal-note">None detected. On desktop, install a wallet extension (MetaMask, Rabby, OKX…). On a phone, use the links below.</p>`;

  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Connect wallet">
      <div class="modal-head">
        <b>Connect a wallet</b>
        <button class="modal-close" aria-label="Close">×</button>
      </div>

      <span class="modal-label">On this device</span>
      <div class="wallet-list">${installedRows}</div>
      ${inApp ? `<p class="modal-note ok">You're browsing inside a wallet app — use an option above.</p>` : ""}

      <div class="modal-section">
        <span class="modal-label">Open in a mobile wallet</span>
        <div class="wallet-list">
          ${deepLinks()
            .map(
              (d) =>
                `<a class="wallet-option" href="${d.href}">
                   ${GENERIC_ICON}<span>${d.name}</span><span class="chev">↗</span>
                 </a>`
            )
            .join("")}
        </div>
        <p class="modal-note">Opens this page inside the wallet's own browser. Come back here once you're in — your wallets will be listed above.</p>
      </div>
      <p class="modal-note">
        By connecting you agree that all actions are final and on-chain.
      </p>
    </div>`;

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeModal();
  });
  backdrop.querySelector(".modal-close").addEventListener("click", closeModal);
  backdrop.querySelectorAll("[data-rdns]").forEach((btn) =>
    btn.addEventListener("click", () => {
      closeModal();
      connect(btn.dataset.rdns);
    })
  );
  const esc = (e) => e.key === "Escape" && closeModal();
  document.addEventListener("keydown", esc, { once: true });

  document.body.appendChild(backdrop);
}

export function closeModal() {
  document.getElementById("connect-modal")?.remove();
}

/* ------------------------------------------------------------------ */
/* Header wiring                                                       */
/* ------------------------------------------------------------------ */

export function wireHeader(activeNav) {
  document.querySelectorAll(".main-nav a").forEach((a) => {
    if (a.dataset.nav === activeNav) a.classList.add("active");
  });

  const zone = document.getElementById("wallet-zone");
  if (!zone) return;

  let menuOpen = false;

  const render = () => {
    zone.innerHTML = "";
    closeAccountMenu();

    if (!state.address) {
      const btn = document.createElement("button");
      btn.className = "btn connect";
      btn.textContent = "Connect Wallet";
      btn.onclick = () => connect();
      zone.appendChild(btn);
      return;
    }

    const chip = document.createElement("button");
    chip.className = "wallet-chip as-btn";
    const wrong = !isSupportedChain(state.chainId);
    chip.innerHTML = `<span class="dot ${wrong ? "warn" : "on"}"></span>`;
    chip.append(shortAddr(state.address));

    if (wrong && state.chainId) {
      const warn = document.createElement("span");
      warn.className = "chip-warn";
      warn.textContent = "wrong network";
      chip.appendChild(warn);
    } else if (state.balance != null) {
      const bal = document.createElement("span");
      bal.className = "mono";
      bal.style.opacity = ".75";
      bal.textContent = `${fmtAmt(state.balance, 3)} ${CFG.TOKEN_SYMBOL}`;
      chip.appendChild(bal);
    }
    chip.onclick = () => {
      menuOpen = !menuOpen;
      menuOpen ? openAccountMenu(zone, render) : closeAccountMenu();
    };
    zone.appendChild(chip);

    if (menuOpen) openAccountMenu(zone, render);
  };

  onWalletChange(render);

  // keep the balance fresh while connected
  setInterval(() => {
    if (state.address && !menuOpen) refreshBalance().catch(() => {});
  }, 20000);
}

function closeAccountMenu() {
  document.getElementById("account-menu")?.remove();
}

function openAccountMenu(zone, rerender) {
  closeAccountMenu();
  const wrong = !isSupportedChain(state.chainId);
  const chain = CFG.CHAINS[String(state.chainId)];
  const link = explorerLink(state.address, "address");

  const menu = document.createElement("div");
  menu.className = "account-menu";
  menu.id = "account-menu";
  menu.innerHTML = `
    <div class="am-row am-addr mono" title="${state.address}">${state.address}</div>
    <button class="am-row am-btn" data-act="copy">Copy address</button>
    <div class="am-row am-static">Balance <b>${state.balance != null ? fmtAmt(state.balance, 4) + " " + CFG.TOKEN_SYMBOL : "…"}</b></div>
    <div class="am-row am-static">Network <b>${chain?.name ?? `chain ${state.chainId}`}</b></div>
    ${wrong ? `<button class="am-row am-btn am-switch" data-act="switch">Switch to ${preferredChain()?.name ?? "supported network"}</button>` : ""}
    ${link ? `<a class="am-row am-btn" data-act="explorer" href="${link}" target="_blank" rel="noopener">View on explorer ↗</a>` : ""}
    <button class="am-row am-btn am-disconnect" data-act="disconnect">Disconnect</button>
  `;
  zone.appendChild(menu);

  menu.querySelector('[data-act="copy"]').addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.address);
      menu.querySelector('[data-act="copy"]').textContent = "Copied ✓";
      setTimeout(rerender, 900);
    } catch {
      toast("Copy failed — select it manually.", true);
    }
  });
  menu.querySelector('[data-act="disconnect"]').addEventListener("click", () => {
    closeAccountMenu();
    disconnect();
  });
  menu.querySelector('[data-act="switch"]')?.addEventListener("click", () => {
    closeAccountMenu();
    ensureChain()
      .then(() => toast("Network switched."))
      .catch(() => {});
  });
}

/* ------------------------------------------------------------------ */
/* Formatting / status helpers                                         */
/* ------------------------------------------------------------------ */

export { shortAddr, fmtAmt, fmtDuration, fmtDurationLong, humanTime, UNIT_SECONDS };

export function statusName(s) {
  return STATUS_NAMES[Number(s)] ?? "Unknown";
}
export function chipClass(s) {
  return STATUS_CHIPS[Number(s)] ?? "";
}

export function explorerLink(hashOrAddr, kind = "address") {
  const chain = CFG.CHAINS[String(state.chainId ?? "")];
  const base = chain?.explorer;
  if (!base) return null;
  return `${base.replace(/\/$/, "")}/${kind}/${hashOrAddr}`;
}

/* Live countdown ticker: fn(nowSeconds) updates DOM each second. */
export function ticker(el, renderFn) {
  const tick = () => {
    if (!el.isConnected) return clearInterval(handle);
    renderFn(Math.floor(Date.now() / 1000));
  };
  const handle = setInterval(tick, 1000);
  tick();
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

export function toast(msg, isError = false, txHash = null) {
  document.querySelectorAll(".tx-toast").forEach((t) => t.remove());
  const el = document.createElement("div");
  el.className = "tx-toast" + (isError ? " err" : "");
  el.textContent = msg;
  if (txHash) {
    const link = explorerLink(txHash, "tx");
    if (link) {
      const a = document.createElement("a");
      a.href = link;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "view ↗";
      el.appendChild(a);
    }
  }
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 7000 : 5000);
}

/** Wrap a tx promise with pending/success/error toasts. Returns result. */
export async function sendTx(label, txPromise) {
  let tx;
  try {
    tx = await txPromise;
  } catch (err) {
    toast(`${label} rejected: ${cleanErr(err)}`, true);
    throw err;
  }
  toast(`${label} sent…`);
  try {
    const receipt = await tx.wait();
    toast(`${label} confirmed`, false, receipt.hash);
    return receipt;
  } catch (err) {
    toast(`${label} failed: ${cleanErr(err)}`, true, tx.hash);
    throw err;
  }
}

export function cleanErr(err) {
  const reasons = [
    err?.info?.error?.message,
    err?.shortMessage,
    err?.reason,
    err?.data?.message,
    typeof err?.message === "string" ? err.message.match(/reason="([^"]+)"/)?.[1] : null,
    err?.message,
  ].filter(Boolean);
  const raw = reasons[0] ?? "unknown error";
  return String(raw).replace(/^execution reverted:?\s*/i, "").slice(0, 140);
}
