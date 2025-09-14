// src/webhooks.ts
import crypto from "crypto";
import { prisma } from './prisma.js';
/**
 * verifyHmac - verifies Shopify HMAC header using given secret
 * Accepts Buffer (preferred), string, or an object (will stringify as last resort).
 */
export function verifyHmac(rawBody, hmacHeader, secret) {
    if (!hmacHeader)
        return false;
    // Normalize input into Buffer
    let dataBuf;
    if (Buffer.isBuffer(rawBody)) {
        dataBuf = rawBody;
    }
    else if (typeof rawBody === "string") {
        dataBuf = Buffer.from(rawBody, "utf8");
    }
    else {
        // Last resort: stringify object (not ideal for exact HMAC matching,
        // but prevents crashes and helps debugging).
        try {
            dataBuf = Buffer.from(JSON.stringify(rawBody), "utf8");
        }
        catch (err) {
            console.warn("verifyHmac: failed to stringify rawBody", err);
            return false;
        }
    }
    // Compute HMAC
    const computed = crypto.createHmac("sha256", secret).update(dataBuf).digest("base64");
    try {
        return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmacHeader));
    }
    catch (err) {
        // timingSafeEqual throws if buffers have different length — treat as invalid
        console.warn("verifyHmac: timingSafeEqual error", err);
        return false;
    }
}
/**
 * processWebhookPayload - handle specific topics (upsert minimal data)
 * Updates tenant-specific data: customers, products, orders.
 */
export async function processWebhookPayload(topic, shop, payload) {
    // find tenant
    const tenant = await prisma.tenant.findUnique({ where: { shop } });
    if (!tenant) {
        console.warn(`Webhook for unknown tenant ${shop}`);
        return;
    }
    const tenantId = tenant.id;
    try {
        if (topic.startsWith("orders/")) {
            // Upsert customer if present
            let customerId;
            if (payload.customer?.id) {
                const shopifyCustomerId = String(payload.customer.id);
                const cust = await prisma.customer.upsert({
                    where: { tenantId_shopifyCustomerId: { tenantId, shopifyCustomerId } },
                    update: {
                        email: payload.customer.email ?? undefined,
                        firstName: payload.customer.first_name ?? undefined,
                        lastName: payload.customer.last_name ?? undefined,
                        updatedAt: payload.customer.updated_at ? new Date(payload.customer.updated_at) : undefined,
                    },
                    create: {
                        tenantId,
                        shopifyCustomerId,
                        email: payload.customer.email ?? null,
                        firstName: payload.customer.first_name ?? null,
                        lastName: payload.customer.last_name ?? null,
                        createdAt: payload.customer.created_at ? new Date(payload.customer.created_at) : undefined,
                        updatedAt: payload.customer.updated_at ? new Date(payload.customer.updated_at) : undefined,
                    },
                });
                customerId = cust.id;
            }
            // Upsert order
            const shopifyOrderId = String(payload.id);
            await prisma.order.upsert({
                where: { tenantId_shopifyOrderId: { tenantId, shopifyOrderId } },
                update: {
                    orderNumber: payload.order_number ? String(payload.order_number) : undefined,
                    totalPrice: payload.total_price ?? "0.00",
                    currency: payload.currency ?? undefined,
                    createdAt: payload.created_at ? new Date(payload.created_at) : undefined,
                    customerId: customerId ?? undefined,
                },
                create: {
                    tenantId,
                    shopifyOrderId,
                    orderNumber: payload.order_number ? String(payload.order_number) : undefined,
                    totalPrice: payload.total_price ?? "0.00",
                    currency: payload.currency ?? undefined,
                    createdAt: payload.created_at ? new Date(payload.created_at) : undefined,
                    customerId: customerId ?? undefined,
                },
            });
            return;
        }
        if (topic === "customers/create" || topic === "customers/update") {
            const shopifyCustomerId = String(payload.id);
            await prisma.customer.upsert({
                where: { tenantId_shopifyCustomerId: { tenantId, shopifyCustomerId } },
                update: {
                    email: payload.email ?? undefined,
                    firstName: payload.first_name ?? undefined,
                    lastName: payload.last_name ?? undefined,
                    updatedAt: payload.updated_at ? new Date(payload.updated_at) : undefined,
                },
                create: {
                    tenantId,
                    shopifyCustomerId,
                    email: payload.email ?? null,
                    firstName: payload.first_name ?? null,
                    lastName: payload.last_name ?? null,
                    createdAt: payload.created_at ? new Date(payload.created_at) : undefined,
                    updatedAt: payload.updated_at ? new Date(payload.updated_at) : undefined,
                },
            });
            return;
        }
        if (topic === "products/create" || topic === "products/update") {
            const shopifyProductId = String(payload.id);
            const sku = payload.variants && payload.variants[0]?.sku ? payload.variants[0].sku : null;
            const price = payload.variants && payload.variants[0]?.price ? payload.variants[0].price : "0.00";
            await prisma.product.upsert({
                where: { tenantId_shopifyProductId: { tenantId, shopifyProductId } },
                update: {
                    title: payload.title ?? undefined,
                    sku,
                    price,
                    createdAt: payload.created_at ? new Date(payload.created_at) : undefined,
                },
                create: {
                    tenantId,
                    shopifyProductId,
                    title: payload.title ?? "Untitled",
                    sku,
                    price,
                    createdAt: payload.created_at ? new Date(payload.created_at) : undefined,
                },
            });
            return;
        }
        // fallback: store raw event if Event table exists; otherwise log
        try {
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore - event model may not exist in all schemas
            if (prisma.event) {
                // store payload as JSON in event table
                await prisma.event.create({
                    data: { tenantId, eventType: topic, payload },
                });
            }
            else {
                console.debug("No Event model present — skipping raw event persistence");
            }
        }
        catch (e) {
            console.warn("Failed to persist fallback event:", e);
        }
    }
    catch (err) {
        console.error("processWebhookPayload error:", err);
        // swallow error to prevent webhook retries from spamming
    }
}
//# sourceMappingURL=webhooks.js.map