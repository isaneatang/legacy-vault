// Legacy Vault — shared frontend runtime.
// Wallet layer: zero-dependency EIP-1193 module with EIP-6963 multi-wallet
// discovery, mobile deep links, auto network switch/add, and an account menu
// (copy address, balance, explorer, disconnect). Contract access via ethers v6.

import {
  LV_ABI,
  ERC20_ABI,
  NATIVE_ADDRESS,
  shortAddr,
  fmtAmt,
  fmtDuration,
  fmtDurationLong,
  humanTime,
  UNIT_SECONDS,
  STATUS_NAMES,
  STATUS_CHIPS,
} from "./helpers.js?v=9";

const CFG = window.LV_CONFIG;

/** WalletConnect project id: build-time env override (js/env.js) wins over
 *  the committed default in js/config.js. */
function wcProjectId() {
  return CFG.WC_PROJECT_ID || window.LV_ENV?.WC_PROJECT_ID || "";
}

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
  // Prefer chains that actually host the vault (testnet/mainnet); skip local dev.
  const hosted = supportedChainIds();
  if (hosted.length) return CFG.CHAINS[hosted[0]]?.rpc ?? null;
  const anyRpc = Object.values(CFG.CHAINS).find((c) => c.rpc);
  return anyRpc?.rpc ?? null;
}

/* Some chain RPCs (e.g. rpc.bohr.life) send no CORS headers, which silently
 * kills every browser-direct read for logged-out visitors. When a same-origin
 * proxy is configured (see /api/* rewrites in vercel.json), prefer it; fall
 * back to the absolute RPC when the proxy isn't available (local dev). */
let readRpcPromise = null;
function resolveReadRpc() {
  if (!readRpcPromise) {
    readRpcPromise = (async () => {
      const abs = defaultReadRpc();
      if (!abs) return null;
      const proxy = (CFG.RPC_PROXY ?? {})[abs];
      if (!proxy || location.protocol === "file:") return abs;
      try {
        // ethers needs an absolute URL even though the proxy is same-origin.
        const url = new URL(proxy, location.href).toString();
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        });
        const j = await r.json();
        if (j && j.result) return url;
      } catch {}
      return abs;
    })();
    readRpcPromise.catch(() => {});
  }
  return readRpcPromise;
}

export function vaultAddress() {
  const byChain = CFG.VAULT_ADDRESS_BY_CHAIN ?? {};
  const key = String(state.chainId ?? "");
  // Unknown/wrong chain (e.g. logged out): fall back to the first configured
  // hosted chain rather than a stale default address.
  return byChain[key] || byChain[supportedChainIds()[0] ?? ""] || CFG.VAULT_ADDRESS;
}

export function contractFor(signerOrProvider) {
  const addr = vaultAddress();
  if (!addr || /^0x0+$/.test(addr)) throw new Error("Vault address not configured. Edit frontend/js/config.js");
  return new ethers.Contract(addr, LV_ABI, signerOrProvider);
}

/** Read-only contract. Uses the injected wallet only when its network is
 *  supported; otherwise reads through a public RPC so pages still render. */
export function readOnlyContract() {
  if (state.chainId && window.ethereum && isSupportedChain(state.chainId)) {
    return contractFor(new ethers.BrowserProvider(window.ethereum, "any"));
  }
  if (!state.readProvider) {
    const url = state.readRpcUrl ?? defaultReadRpc();
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
/* Vault assets (native BOT or ERC-20)                                 */
/* ------------------------------------------------------------------ */

const assetCache = new Map(); // lowercase token address -> meta

/** Any read-capable provider: injected wallet when on a supported chain,
 *  otherwise the configured public RPC. */
function anyReadProvider() {
  if (state.chainId && window.ethereum && isSupportedChain(state.chainId)) {
    return new ethers.BrowserProvider(window.ethereum, "any");
  }
  if (!state.readProvider) {
    const url = state.readRpcUrl ?? defaultReadRpc();
    state.readProvider = url ? new ethers.JsonRpcProvider(url) : null;
  }
  return state.readProvider;
}

/**
 * Metadata for a vault's asset. Zero address => native BOT.
 * Tokens listed in CFG.TOKENS (lowercase-keyed) skip the RPC round-trip;
 * unknown tokens resolve symbol/decimals on-chain, with a short-address
 * fallback so pages never break on a misconfigured token.
 */
export async function assetMeta(tokenAddress) {
  const addr = String(tokenAddress ?? "").toLowerCase();
  if (!addr || addr === NATIVE_ADDRESS) {
    return { address: null, native: true, symbol: CFG.TOKEN_SYMBOL || "BOT", decimals: 18 };
  }
  const cached = assetCache.get(addr);
  if (cached) return cached;

  let meta = null;
  for (const chainTokens of Object.values(CFG.TOKENS ?? {})) {
    for (const [key, t] of Object.entries(chainTokens ?? {})) {
      if (key.toLowerCase() === addr && t?.symbol && t?.decimals != null) {
        meta = { address: key.toLowerCase(), native: false, symbol: t.symbol, decimals: Number(t.decimals) };
        break;
      }
    }
    if (meta) break;
  }
  if (!meta) {
    try {
      const t = new ethers.Contract(addr, ERC20_ABI, anyReadProvider());
      const [symbol, decimals] = await Promise.all([t.symbol(), t.decimals()]);
      meta = { address: addr, native: false, symbol, decimals: Number(decimals) };
    } catch {}
  }
  if (!meta) meta = { address: addr, native: false, symbol: shortAddr(addr), decimals: 18 };
  assetCache.set(addr, meta);
  return meta;
}

/** ERC-20 approval dance before createVault/deposit on a token vault. */
export async function ensureAllowance(signer, tokenMeta, spender, amountWei) {
  if (!tokenMeta.native) {
    const token = new ethers.Contract(tokenMeta.address, ERC20_ABI, signer);
    const owner = await signer.getAddress();
    // Skip approve only when we can positively confirm enough allowance;
    // any read failure falls through to an explicit (visible) approval.
    try {
      const current = await token.allowance(owner, spender);
      if (current >= amountWei) return;
    } catch {}
    await sendTx(`${tokenMeta.symbol} approval`, token.approve(spender, amountWei));
  }
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

/* ------------------------------------------------------------------ */
/* Reown AppKit — the connect modal (default UI, all wallets)          */
/* ------------------------------------------------------------------ */

let appKit = null;
let appKitPromise = null;

/** Chain objects in the shape AppKit expects, built from config. */
function appkitChains() {
  const ids = supportedChainIds().length ? supportedChainIds() : Object.keys(CFG.CHAINS);
  const sym = CFG.TOKEN_SYMBOL || "BOT";
  return ids
    .map((id) => {
      const c = CFG.CHAINS[id];
      if (!c?.rpc) return null;
      return {
        id: Number(id),
        name: c.name,
        nativeCurrency: { name: sym, symbol: sym, decimals: 18 },
        rpcUrls: { default: { http: [c.rpc] } },
        ...(c.explorer ? { blockExplorers: { default: { name: "Explorer", url: c.explorer } } } : {}),
      };
    })
    .filter(Boolean);
}

function loadAppKitModules() {
  return Promise.all([
    import("https://cdn.jsdelivr.net/npm/@reown/appkit@1/+esm"),
    import("https://cdn.jsdelivr.net/npm/@reown/appkit-adapter-ethers@1/+esm"),
  ]);
}

async function ensureAppKit() {
  if (!wcProjectId()) return null;
  if (!appKitPromise) {
    appKitPromise = (async () => {
      const [{ createAppKit }, { EthersAdapter }] = await loadAppKitModules();
      const networks = appkitChains();
      const ak = createAppKit({
        adapters: [new EthersAdapter()],
        networks,
        projectId: wcProjectId(),
        themeMode: "dark",
        metadata: {
          name: "Legacy Vault",
          description: "On-chain inheritance / dead man's switch for BOT Chain",
          url: location.origin,
          icons: [],
        },
        features: { analytics: false },
      });
      appKit = ak;
      return ak;
    })();
    appKitPromise.catch(() => { appKitPromise = null; }); // allow retry after a failure
  }
  return appKitPromise;
}

/** Resolves once AppKit reports a connected address (or rejects on close). */
function waitConnected(ak, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    let done = false;
    let unsubState = null;
    const finish = (fn, val) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      try { unsubState?.(); } catch {}
      fn(val);
    };
    const check = async () => {
      try { const a = await ak.getAddress?.(); if (a) finish(resolve, a); } catch {}
    };
    const poll = setInterval(check, 500);
    // Reject shortly after the user closes the modal without connecting.
    try {
      unsubState = ak.subscribeState?.((s) => {
        if (s?.open === false) setTimeout(() => { check(); if (!done) finish(reject, new Error("closed")); }, 800);
      });
    } catch {}
    setTimeout(() => finish(reject, new Error("Connection timed out")), timeoutMs);
    check();
  });
}

async function connectViaReown() {
  const ak = await ensureAppKit();
  if (!ak) return;
  toast("Opening wallet options…");
  ak.open();
  try {
    await waitConnected(ak);
    await activate({
      info: { uuid: "reown", name: "Wallet", icon: null, rdns: "reown" },
      provider: ak.getWalletProvider(),
    });
    toast("Connected");
    ensureChain().catch(() => {});
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (!/rejected|closed|declined/i.test(msg)) toast(`Connect failed: ${cleanErr(err)}`, true);
  }
}

/** If the last session used Reown AppKit, restore it silently so reloads
 *  keep the user connected (AppKit persists its own sessions). */
async function resumeReown() {
  if (localStorage.getItem(LS_WALLET) !== "reown") return false;
  try {
    const ak = await ensureAppKit();
    if (!ak) return false;
    const addr = await ak.getAddress?.();
    if (!addr) return false;
    await activate(
      { info: { uuid: "reown", name: "Wallet", icon: null, rdns: "reown" }, provider: ak.getWalletProvider() },
      { silent: true }
    );
    return !!state.address;
  } catch {
    return false;
  }
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
  patchBalanceUI();
}

/* Lightweight in-place update of balance text — deliberately does NOT emit,
   so a background poll never re-renders whole pages. */
function patchBalanceUI() {
  if (state.balance == null) return;
  const txt = `${fmtAmt(state.balance, 3)} ${CFG.TOKEN_SYMBOL}`;
  document.querySelectorAll("[data-balance-slot]").forEach((el) => {
    el.textContent = txt;
  });
}

export async function initWallet() {
  // Resolve the read endpoint (same-origin proxy vs absolute RPC) before any
  // page render, so logged-out visitors don't fire reads at a CORS-dead RPC.
  await resolveReadRpc().then((url) => { state.readRpcUrl = url; }).catch(() => {});
  requestProviders();
  // give announcements a tick to arrive
  await new Promise((r) => setTimeout(r, 60));

  const savedRdns = localStorage.getItem(LS_WALLET);

  if (savedRdns === "reown") {
    const resumed = await resumeReown();
    if (resumed) {
      if (!isSupportedChain(state.chainId)) ensureChain().catch(() => {});
      emit();
      return;
    }
  }

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

export function connect() {
  // Primary path: Reown AppKit modal (QR, deep links, injected wallets —
  // its default UI handles mobile redirect flows far better than a
  // hand-rolled list). Fallback when no project id is configured: plain
  // injected-wallet request so zero-config local dev still works.
  if (wcProjectId()) {
    return ensureAppKit()
      .then((ak) => (ak ? connectViaReown() : Promise.resolve()))
      .catch((err) => toast(`Connect failed: ${cleanErr(err)}`, true));
  }
  const detail = fallbackWallet();
  if (!detail) {
    toast("No wallet detected. Install MetaMask or open this site in a wallet app.", true);
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

export async function disconnect({ quiet = false } = {}) {
  const viaReown = localStorage.getItem(LS_WALLET) === "reown";
  localStorage.removeItem(LS_CONNECTED);
  localStorage.removeItem(LS_WALLET);
  try {
    // Terminate AppKit's session (covers WalletConnect relay + injected).
    if (viaReown && appKit) await appKit.disconnect();
  } catch {}
  try {
    // Terminate any lingering WalletConnect session on the raw provider.
    if (state.provider?.session) await state.provider.disconnect();
  } catch {}
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

/* Coalesced emit: bursty events (connect + balance + chain arriving together)
   collapse into a single listener pass, so pages re-render once, not N times. */
let emitQueued = false;
function emit() {
  if (emitQueued) return;
  emitQueued = true;
  setTimeout(() => {
    emitQueued = false;
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch (err) {
        console.warn("[lv] wallet-listener error:", err);
      }
    }
  }, 50);
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
      bal.dataset.balanceSlot = "1";
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
    <div class="am-row am-static">Balance <b data-balance-slot>${state.balance != null ? fmtAmt(state.balance, 4) + " " + CFG.TOKEN_SYMBOL : "…"}</b></div>
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
      toast("Copy failed. Select it manually.", true);
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

/* Live countdown ticker: fn(nowSeconds) updates DOM each second.
   renderFn failures are contained so a bad read never freezes the timer. */
export function ticker(el, renderFn) {
  const tick = () => {
    if (!el.isConnected) return clearInterval(handle);
    try {
      renderFn(Math.floor(Date.now() / 1000));
    } catch (err) {
      console.warn("ticker error:", err?.stack ?? err?.message ?? err);
    }
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
