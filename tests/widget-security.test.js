"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const widgetOrigin = "https://widget-v3.kkiapay.me";
const sdkFile = path.join(__dirname, "../public/vendor/kkiapay-2.0.38.js");
const sdkSource = fs.readFileSync(sdkFile, "utf8");

function loadWidget({ open = true } = {}) {
  const listeners = new Map();
  const frameListeners = new Map();
  const successes = [];
  const openedLinks = [];
  const postedMessages = [];
  let closeCalls = 0;
  let focusCalls = 0;
  const frameWindow = {
    postMessage(data, origin) {
      postedMessages.push({ data, origin });
    },
  };
  const frame = {
    style: {},
    contentWindow: null,
    isConnected: false,
    setAttribute() {},
    addEventListener(name, listener) {
      frameListeners.set(name, listener);
    },
    remove() {
      this.isConnected = false;
      this.contentWindow = null;
    },
  };
  const customElements = new Map();
  const addEventListener = (name, listener) => {
    const entries = listeners.get(name) || [];
    entries.push(listener);
    listeners.set(name, entries);
  };
  const window = {
    addEventListener,
    navigator: { language: "fr" },
    location: { href: "https://school.example.invalid/" },
    customElements: {
      get: (name) => customElements.get(name),
      define: (name, element) => customElements.set(name, element),
    },
    open(url, target) {
      openedLinks.push({ url, target });
      return { focus: () => focusCalls++ };
    },
  };
  const context = vm.createContext({
    window,
    addEventListener,
    HTMLElement: class {},
    document: {
      createElement(tag) {
        assert.equal(tag, "iframe");
        return frame;
      },
      querySelector: () => null,
      body: {
        appendChild(element) {
          assert.equal(element, frame);
          frame.isConnected = true;
          frame.contentWindow = frameWindow;
        },
      },
    },
  });
  vm.runInContext(sdkSource, context, { filename: sdkFile });
  assert.equal(listeners.get("message")?.length, 1);
  window.addSuccessListener((data) => successes.push(data));
  window.addKkiapayCloseListener(() => closeCalls++);
  if (open) window.openKkiapayWidget({ key: "test-public", amount: 3500, sandbox: true });
  return {
    window,
    context,
    frame,
    frameWindow,
    successes,
    openedLinks,
    postedMessages,
    closeCalls: () => closeCalls,
    focusCalls: () => focusCalls,
    load: () => frameListeners.get("load")(),
    message(data, { origin = widgetOrigin, source = frameWindow } = {}) {
      for (const listener of listeners.get("message")) listener({ data, origin, source });
    },
  };
}

test("Le SDK ignore les messages de paiement, fermeture et Wave provenant d’une autre origine ou fenêtre", async (t) => {
  const forgeries = [
    ["origine tierce", (sdk) => ({ origin: "https://attacker.example.invalid", source: sdk.frameWindow })],
    ["sous-domaine trompeur", (sdk) => ({ origin: `${widgetOrigin}.attacker.example.invalid`, source: sdk.frameWindow })],
    ["autre port", (sdk) => ({ origin: `${widgetOrigin}:8443`, source: sdk.frameWindow })],
    ["origine opaque", (sdk) => ({ origin: "null", source: sdk.frameWindow })],
    ["autre fenêtre sur l’origine KKiaPay", () => ({ origin: widgetOrigin, source: {} })],
    ["source absente", () => ({ origin: widgetOrigin, source: null })],
  ];
  for (const [name, forgery] of forgeries) {
    await t.test(name, () => {
      const sdk = loadWidget();
      const sender = forgery(sdk);
      for (const [name, data] of [
        ["PAYMENT_SUCCESS", { transactionId: "forged-payment" }],
        ["CLOSE_WIDGET", {}],
        ["WAVE_LINK", "https://attacker.example.invalid/payment"],
      ]) {
        assert.doesNotThrow(() => sdk.message({ name, data }, sender));
      }
      assert.deepEqual(sdk.successes, []);
      assert.equal(sdk.closeCalls(), 0);
      assert.equal(sdk.frame.isConnected, true);
      assert.deepEqual(sdk.openedLinks, []);
      assert.equal(sdk.focusCalls(), 0);
    });
  }
});

test("Le SDK transmet les messages provenant de sa propre iframe KKiaPay", () => {
  const sdk = loadWidget();
  assert.equal(sdk.frame.src, widgetOrigin);
  sdk.load();
  assert.equal(sdk.postedMessages.length, 1);
  assert.equal(sdk.postedMessages[0].origin, widgetOrigin);
  assert.equal(sdk.postedMessages[0].data.name, "INIT_WIDGET");
  assert.equal(sdk.postedMessages[0].data.data.amount, 3500);

  const payment = { transactionId: "verified-by-server-later" };
  sdk.message({ name: "PAYMENT_SUCCESS", data: payment });
  assert.deepEqual(sdk.successes, [payment]);
  sdk.message({ name: "WAVE_LINK", data: "https://pay.wave.com/test-only" });
  assert.deepEqual(sdk.openedLinks, [{ url: "https://pay.wave.com/test-only", target: "_blank" }]);
  assert.equal(sdk.focusCalls(), 1);
  sdk.message({ name: "CLOSE_WIDGET" });
  assert.equal(sdk.closeCalls(), 1);
  assert.equal(sdk.frame.isConnected, false);
});

test("Le SDK ignore les messages malformés, les méthodes héritées et les handlers non exécutables", () => {
  const sdk = loadWidget();
  vm.runInContext("globalThis.inheritedDispatches = 0; Object.prototype.PAYMENT_FORGED = () => { globalThis.inheritedDispatches++; };", sdk.context);
  for (const data of [
    undefined, null, false, true, 0, 1, "PAYMENT_SUCCESS", [], {},
    { name: ["PAYMENT_SUCCESS"] },
    { name: "UNKNOWN_EVENT" },
    { name: "PAYMENT_FORGED" },
    { name: "__proto__" },
    { name: "constructor" },
    { name: "toString" },
    { name: "hasOwnProperty" },
  ]) {
    assert.doesNotThrow(() => sdk.message(data));
  }
  assert.equal(sdk.context.inheritedDispatches, 0);
  assert.deepEqual(sdk.successes, []);
  assert.equal(sdk.closeCalls(), 0);
  assert.deepEqual(sdk.openedLinks, []);
  sdk.window.addSuccessListener({ invalid: true });
  assert.doesNotThrow(() => sdk.message({ name: "PAYMENT_SUCCESS", data: {} }));
});

test("Une source nulle ne peut pas envoyer un message avant l’ouverture de l’iframe", () => {
  const sdk = loadWidget({ open: false });
  assert.equal(sdk.frame.contentWindow, null);
  sdk.message({ name: "PAYMENT_SUCCESS", data: { transactionId: "no-iframe" } }, { source: null });
  assert.deepEqual(sdk.successes, []);
});
