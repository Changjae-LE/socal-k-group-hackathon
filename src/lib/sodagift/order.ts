// SodaGift LINK order creation + read-back (CLAUDE.md §11 — contract VERIFIED, order 33815).
// Server-only. Request body is exactly the documented LINK shape — nothing more.

import "server-only";
import { SodaGiftError, sodaGetJson, sodaPostJson } from "@/lib/sodagift/client";

type CreateOrderResponse = {
  id?: number | string;
  order_id?: number | string;
  status?: string;
  order?: { id?: number | string };
  order_item?: { id?: number | string; status?: string };
  order_items?: Array<{ id?: number | string; status?: string }>;
};

export type CreatedLinkOrder = {
  orderId: string;
  orderItemId: string | null;
  orderStatus: string | null;
  itemStatus: string | null;
};

export async function createLinkOrder(args: {
  item: { id: number; custom_amount?: number };
  recipientName: string;
  senderName: string;
  message?: string;
  externalReferenceId: string;
}): Promise<CreatedLinkOrder> {
  const body: Record<string, unknown> = {
    item: args.item,
    delivery: {
      method: "LINK",
      recipient: { name: args.recipientName }, // LINK: name only — no email/phone/address
      sender: { name: args.senderName },
    },
    external_reference_id: args.externalReferenceId,
  };
  if (args.message) body.message = args.message.slice(0, 2000);

  const json = await sodaPostJson<CreateOrderResponse>("/v1/orders", body);
  const rawId = json.id ?? json.order_id ?? json.order?.id;
  if (rawId == null) {
    throw new SodaGiftError("POST /v1/orders succeeded but carried no order id", 200);
  }
  const item = json.order_item ?? (Array.isArray(json.order_items) ? json.order_items[0] : undefined);
  return {
    orderId: String(rawId),
    orderItemId: item?.id != null ? String(item.id) : null,
    orderStatus: json.status ?? null,
    itemStatus: item?.status ?? null,
  };
}

type GetOrderResponse = {
  status?: string;
  order_item?: { status?: string; delivery?: { link?: string } };
  order_items?: Array<{ status?: string; delivery?: { link?: string } }>;
};

export type FetchedLinkOrder = {
  orderStatus: string | null;
  itemStatus: string | null;
  /** `order_items[0].delivery.link` — the bearer voucher URL. Treat as a secret. */
  voucherLink: string | null;
};

export async function getOrderById(orderId: string): Promise<FetchedLinkOrder> {
  const json = await sodaGetJson<GetOrderResponse>(`/v1/orders/${encodeURIComponent(orderId)}`);
  const item = Array.isArray(json.order_items) ? json.order_items[0] : json.order_item;
  const link = item?.delivery?.link;
  return {
    orderStatus: json.status ?? null,
    itemStatus: item?.status ?? null,
    voucherLink: typeof link === "string" && link.length > 0 ? link : null,
  };
}
