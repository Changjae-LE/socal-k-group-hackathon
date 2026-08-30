const functions = require("firebase-functions");

let SODAGIFT_API_KEY = "";
try {
  SODAGIFT_API_KEY = require("./secrets").SODAGIFT_API_KEY || "";
} catch (_) {
  SODAGIFT_API_KEY = "";
}

const BASE = "https://biz-sandbox-api.sodagift.com";
const ADMIN = "streamdrop";

function sodaHeaders() {
  return {
    "SODA-API-KEY": SODAGIFT_API_KEY,
    accept: "application/json",
    "content-type": "application/json",
  };
}

async function soda(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { ...sodaHeaders(), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!res.ok) throw new Error(`soda ${res.status}: ${text.slice(0, 240)}`);
  return body;
}

async function createLinkGift(nickname, country, refId) {
  await soda("/v1/accounts/balance");
  const catalog = await soda(`/v1/products?country_code=${encodeURIComponent(country)}&delivery_method=LINK&size=100`);
  const sale = (catalog.products || [])
    .filter((p) => p.availability === "ON_SALE" && (p.amount || p.min_amount))
    .sort((a, b) => Number(a.amount || a.min_amount) - Number(b.amount || b.min_amount));
  if (!sale.length) throw new Error(`no LINK product for ${country}`);
  const product = sale[0];
  const item = { id: product.id };
  if (product.amount == null && product.min_amount != null) item.custom_amount = product.min_amount;
  const order = await soda("/v1/orders", {
    method: "POST",
    body: JSON.stringify({
      item,
      delivery: {
        method: "LINK",
        recipient: { name: nickname || "Winner" },
        sender: { name: "StreamDrop" },
      },
      message: "Congratulations! You won the StreamDrop giveaway",
      external_reference_id: String(refId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 100),
    }),
  });
  const deadline = Date.now() + 28000;
  while (Date.now() < deadline) {
    const detail = await soda(`/v1/orders/${order.id}`);
    const items = detail.order_items || (detail.order_item ? [detail.order_item] : []);
    for (const it of items) {
      const link = it.delivery && it.delivery.link;
      if (link) {
        return { link, orderId: String(order.id), productName: product.name || "SodaGift" };
      }
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("gift link not ready");
}

exports.createGift = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-admin-token");
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  if ((req.get("x-admin-token") || "") !== ADMIN) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  if (!SODAGIFT_API_KEY) {
    res.status(500).json({ error: "SodaGift key is not configured on the server" });
    return;
  }
  const nickname = (req.body && req.body.nickname) || "";
  const country = (req.body && req.body.country) || "";
  const refId = (req.body && req.body.refId) || `sd${Date.now()}`;
  if (!country) {
    res.status(400).json({ error: "country required" });
    return;
  }
  try {
    res.json(await createLinkGift(nickname, country, refId));
  } catch (err) {
    console.error("createGift failed", err.message);
    res.status(502).json({ error: err.message || "soda failed" });
  }
});
