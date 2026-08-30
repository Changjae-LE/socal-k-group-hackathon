const SODA = "https://biz-sandbox-api.sodagift.com";
const ADMIN = "streamdrop";

function cors(res) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "https://hackathon-korean.web.app");
  headers.set("Access-Control-Allow-Headers", "Content-Type, x-admin-token");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  return new Response(res.body, { status: res.status, headers });
}

function sodaHeaders(env) {
  return {
    "SODA-API-KEY": env.SODAGIFT_API_KEY,
    accept: "application/json",
    "content-type": "application/json",
  };
}

async function soda(env, path, opts = {}) {
  const res = await fetch(SODA + path, {
    ...opts,
    headers: { ...sodaHeaders(env), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch (_) {
    body = {};
  }
  if (!res.ok) throw new Error(`soda ${res.status}: ${text.slice(0, 240)}`);
  return body;
}

async function createLinkGift(env, nickname, country, refId) {
  await soda(env, "/v1/accounts/balance");
  const catalog = await soda(
    env,
    `/v1/products?country_code=${encodeURIComponent(country)}&delivery_method=LINK&size=100`,
  );
  const sale = (catalog.products || [])
    .filter((p) => p.availability === "ON_SALE" && (p.amount || p.min_amount))
    .sort((a, b) => Number(a.amount || a.min_amount) - Number(b.amount || b.min_amount));
  if (!sale.length) throw new Error("no LINK product for " + country);

  const product = sale[0];
  const item = { id: product.id };
  if (product.amount == null && product.min_amount != null) {
    item.custom_amount = product.min_amount;
  }

  const order = await soda(env, "/v1/orders", {
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
    const detail = await soda(env, "/v1/orders/" + order.id);
    const items = detail.order_items || (detail.order_item ? [detail.order_item] : []);
    for (const it of items) {
      const link = it.delivery && it.delivery.link;
      if (link) {
        return {
          link,
          orderId: String(order.id),
          productName: product.name || "SodaGift",
        };
      }
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("gift link not ready");
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }
    if (req.method !== "POST") {
      return cors(Response.json({ error: "POST only" }, { status: 405 }));
    }
    if ((req.headers.get("x-admin-token") || "") !== ADMIN) {
      return cors(Response.json({ error: "forbidden" }, { status: 403 }));
    }
    if (!env.SODAGIFT_API_KEY) {
      return cors(Response.json({ error: "missing SODAGIFT_API_KEY secret" }, { status: 500 }));
    }

    let body = {};
    try {
      body = await req.json();
    } catch (_) {
      body = {};
    }
    const nickname = body.nickname || "";
    const country = body.country || "";
    const refId = body.refId || `sd${Date.now()}`;
    if (!country) {
      return cors(Response.json({ error: "country required" }, { status: 400 }));
    }

    try {
      return cors(Response.json(await createLinkGift(env, nickname, country, refId)));
    } catch (err) {
      return cors(Response.json({ error: err.message || "soda failed" }, { status: 502 }));
    }
  },
};
