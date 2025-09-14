/**
 * fullSync pulls products/customers/orders for a tenant (by tenantId).
 * It relies on the Prisma models and unique constraints:
 *  - Customer @@unique([tenantId, shopifyCustomerId])
 *  - Product  @@unique([tenantId, shopifyProductId])
 *  - Order    @@unique([tenantId, shopifyOrderId])
 */
export declare function fullSync(tenantId: string): Promise<{
    products: number;
    customers: number;
    orders: number;
    backfilled: number;
}>;
//# sourceMappingURL=sync.d.ts.map