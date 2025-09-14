// src/sync.ts
import { prisma } from './prisma.js';
import { makeClient, fetchAllProducts, fetchAllCustomers, fetchAllOrders } from './shopify.js';
/**
 * Helper: fetch single customer from Shopify Admin API using the provided client.
 * Returns the raw customer object or null on 404 / error.
 */
async function fetchShopifyCustomerById(client, shopifyCustomerId) {
    try {
        const resp = await client.get(`/admin/api/2025-04/customers/${shopifyCustomerId}.json`);
        return resp.data?.customer ?? null;
    }
    catch (err) {
        // 404 / not found -> return null (caller handles)
        // log non-404 errors at debug level
        if (err.response?.status && err.response.status !== 404) {
            console.warn(`fetchShopifyCustomerById error ${shopifyCustomerId}:`, err.message || err.toString());
        }
        return null;
    }
}
/**
 * fullSync pulls products/customers/orders for a tenant (by tenantId).
 * It relies on the Prisma models and unique constraints:
 *  - Customer @@unique([tenantId, shopifyCustomerId])
 *  - Product  @@unique([tenantId, shopifyProductId])
 *  - Order    @@unique([tenantId, shopifyOrderId])
 */
export async function fullSync(tenantId) {
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant)
        throw new Error("tenant not found");
    if (!tenant.accessToken || !tenant.shop)
        throw new Error("tenant missing accessToken or shop");
    const client = makeClient(tenant.shop, tenant.accessToken);
    // ---------- PRODUCTS ----------
    const products = await fetchAllProducts(client);
    let productCount = 0;
    for (const p of products) {
        try {
            const shopifyProductId = String(p.id);
            const sku = p.variants && p.variants[0]?.sku ? p.variants[0].sku : null;
            const price = p.variants && p.variants[0]?.price ? p.variants[0].price : "0.00";
            await prisma.product.upsert({
                where: { tenantId_shopifyProductId: { tenantId, shopifyProductId } },
                update: {
                    title: p.title ?? "Untitled",
                    sku,
                    price,
                    createdAt: p.created_at ? new Date(p.created_at) : undefined,
                },
                create: {
                    tenantId,
                    shopifyProductId,
                    title: p.title ?? "Untitled",
                    sku,
                    price,
                    createdAt: p.created_at ? new Date(p.created_at) : undefined,
                },
            });
            productCount++;
        }
        catch (e) {
            console.warn("product upsert failed for item:", p?.id, e?.message || e);
        }
    }
    // ---------- CUSTOMERS ----------
    const customers = await fetchAllCustomers(client);
    let customerCount = 0;
    for (const c of customers) {
        try {
            const shopifyCustomerId = String(c.id);
            const data = {
                email: c.email ?? null,
                firstName: c.first_name ?? null,
                lastName: c.last_name ?? null,
                createdAt: c.created_at ? new Date(c.created_at) : undefined,
                updatedAt: c.updated_at ? new Date(c.updated_at) : undefined,
            };
            console.log("Shopify raw customer:", JSON.stringify(c, null, 2));
            try {
                await prisma.customer.upsert({
                    where: { tenantId_shopifyCustomerId: { tenantId, shopifyCustomerId } },
                    update: data,
                    create: { tenantId, shopifyCustomerId, ...data },
                });
            }
            catch (err) {
                // Fallback if composite upsert fails for some schema shape
                const existing = await prisma.customer.findFirst({ where: { tenantId, shopifyCustomerId } });
                if (existing)
                    await prisma.customer.update({ where: { id: existing.id }, data });
                else
                    await prisma.customer.create({ data: { tenantId, shopifyCustomerId, ...data } });
            }
            customerCount++;
        }
        catch (e) {
            console.warn("customer upsert failed for item:", c?.id, e?.message || e);
        }
    }
    // ---------- ORDERS ----------
    const orders = await fetchAllOrders(client);
    let orderCount = 0;
    for (const o of orders) {
        try {
            const shopifyOrderId = String(o.id);
            let customerId = undefined;
            if (o.customer?.id) {
                const existing = await prisma.customer.findFirst({
                    where: { tenantId, shopifyCustomerId: String(o.customer.id) },
                    select: { id: true },
                });
                customerId = existing?.id;
            }
            const op = {
                orderNumber: o.order_number ? String(o.order_number) : undefined,
                totalPrice: o.total_price ?? "0.00",
                currency: o.currency ?? undefined,
                createdAt: o.created_at ? new Date(o.created_at) : undefined,
                customerId: customerId ?? undefined,
            };
            await prisma.order.upsert({
                where: { tenantId_shopifyOrderId: { tenantId, shopifyOrderId } },
                update: op,
                create: { tenantId, shopifyOrderId, ...op },
            });
            orderCount++;
        }
        catch (e) {
            console.warn("order upsert failed for item:", o?.id, e?.message || e);
        }
    }
    // ---------- BACKFILL: try to fill missing names / email for DB customers ----------
    // Find DB customers for this tenant with missing firstName OR email
    const missing = await prisma.customer.findMany({
        where: {
            tenantId,
            OR: [
                { firstName: null },
                { email: null },
            ],
        },
        select: { id: true, shopifyCustomerId: true, firstName: true, lastName: true, email: true },
        take: 1000, // limit a batch for safety; increase if needed or iterate
    });
    let backfilled = 0;
    for (const row of missing) {
        // If shopifyCustomerId missing, skip
        if (!row.shopifyCustomerId)
            continue;
        try {
            const shopifyCustomer = await fetchShopifyCustomerById(client, row.shopifyCustomerId);
            if (shopifyCustomer) {
                // Only update if there is something new
                const updateData = {};
                if (shopifyCustomer.email && shopifyCustomer.email !== row.email)
                    updateData.email = shopifyCustomer.email;
                if (shopifyCustomer.first_name && shopifyCustomer.first_name !== row.firstName)
                    updateData.firstName = shopifyCustomer.first_name;
                if (shopifyCustomer.last_name && shopifyCustomer.last_name !== row.lastName)
                    updateData.lastName = shopifyCustomer.last_name;
                if (Object.keys(updateData).length > 0) {
                    updateData.updatedAt = shopifyCustomer.updated_at ? new Date(shopifyCustomer.updated_at) : undefined;
                    await prisma.customer.update({ where: { id: row.id }, data: updateData });
                    backfilled++;
                }
            }
            else {
                // Shopify returned nothing for this ID (404), skip
            }
        }
        catch (e) {
            console.warn("backfill failed for", row.shopifyCustomerId, e?.message || e);
        }
    }
    return {
        products: productCount,
        customers: customerCount,
        orders: orderCount,
        backfilled,
    };
}
//# sourceMappingURL=sync.js.map