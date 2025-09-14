// src/webhookRegister.ts
import fetch from "node-fetch";
/**
 * registerWebhooks - create webhooks on Shopify for a tenant
 * shop: e.g. swjgbi-rf.myshopify.com
 * token: Admin API access token (shpat_...)
 * endpointBase: public URL (ngrok or deployed) e.g. https://abc.ngrok.io
 */
export async function registerWebhooks(shop, token, endpointBase) {
    const topics = ["orders/create", "orders/updated", "customers/create", "products/create"];
    const results = [];
    for (const topic of topics) {
        const body = {
            webhook: {
                topic,
                address: `${endpointBase}/api/webhooks/shopify`,
                format: "json"
            }
        };
        const res = await fetch(`https://${shop}/admin/api/2025-04/webhooks.json`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Shopify-Access-Token": token
            },
            body: JSON.stringify(body)
        });
        const text = await res.text();
        results.push({ topic, status: res.status, body: text });
    }
    return results;
}
//# sourceMappingURL=webhookRegister.js.map