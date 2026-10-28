/**
 * Built-in sample project shown on first visit, so anyone can try the full find → patch → apply loop
 * without linking a folder. Each file carries realistic defects across languages and rule families.
 */

export interface SampleFile {
  path: string;
  content: string;
}

const checkout = `// Checkout service: prices a cart, charges the customer, and sends a receipt.
import { db } from "./db";
import { sendReceipt } from "./mailer";

const pendingCharges = new Map<string, number>();

export async function chargeCart(userId: string, cartId: string): Promise<number> {
  const cart = await db.query(\`SELECT * FROM carts WHERE id = '\${cartId}'\`);

  let total = 0;
  for (const item of cart.rows) {
    const product = await db.query("SELECT price FROM products WHERE id = $1", [item.productId]);
    total += product.rows[0].price * item.quantity;
  }

  pendingCharges.set(cartId, total);

  const res = await fetch("https://payments.internal/v1/charge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, amount: total }),
  });

  if (res.status == 200) {
    sendReceipt(userId, total).then(() => console.log("receipt queued"));
  }
  return total;
}
`;

const inventory = `"""Inventory sync worker: pulls stock levels for each SKU from the warehouse API."""
import logging
import time

import requests


class InventorySync:
    def __init__(self, endpoint, batch_size=50):
        self.endpoint = endpoint
        self.batch_size = batch_sise
        self.failed = []

    def fetch_stock(self, sku):
        resp = requests.get(f"{self.endpoint}/stock/{sku}")
        return resp.json()["available"]

    def sync(self, skus, seen=[]):
        for sku in skus:
            try:
                qty = self.fetch_stock(sku)
                logging.infos("synced %s -> %s units", sku, qty)
                seen.append(sku)
            except:
                self.failed.append(sku)
        return seen


def main():
    worker = InventorySync("https://warehouse.internal")
    worker.sycn(["A-100", "B-200", "C-300"])
    time.sleep(1)


if __name__ == "__main__":
    main()
`;

const sessions = `// Session store for the customer portal.
const crypto = require("crypto");
const { exec } = require("child_process");

const SESSION_SECRET = "portal-s3cret-2024-rotate-me";
const sessions = new Map();

function createSession(user) {
  const id = crypto.createHash("md5").update(user.id + SESSION_SECRET + Date.now()).digest("hex");
  sessions.set(id, { user, createdAt: Date.now() });
  return id;
}

function renderGreeting(el, user) {
  el.innerHTML = "<h2>Welcome back, " + user.name + "</h2>";
}

function evaluateDiscount(rule, cart) {
  return eval(rule.expression);
}

function archiveLogs(day) {
  exec(\`tar -czf /var/archive/\${day}.tgz /var/log/portal\`, (err) => {
    if (err) console.error(err);
  });
}

setInterval(() => {
  for (id of sessions.keys()) {
    if (Date.now() - sessions.get(id).createdAt > 3600000) sessions.delete(id);
  }
}, 60000);

module.exports = { createSession, renderGreeting, evaluateDiscount, archiveLogs };
`;

export const SAMPLE_FILES: SampleFile[] = [
  { path: "services/checkout.ts", content: checkout },
  { path: "workers/inventory_sync.py", content: inventory },
  { path: "portal/session-store.js", content: sessions },
];

export const DEMO_NAME = "Sample project";
export const DEMO_ROOT_KEY = "aetherops:sample-project";
