/**
 * verifyHmac - verifies Shopify HMAC header using given secret
 * Accepts Buffer (preferred), string, or an object (will stringify as last resort).
 */
export declare function verifyHmac(rawBody: Buffer | string | any, hmacHeader: string, secret: string): boolean;
/**
 * processWebhookPayload - handle specific topics (upsert minimal data)
 * Updates tenant-specific data: customers, products, orders.
 */
export declare function processWebhookPayload(topic: string, shop: string, payload: any): Promise<void>;
//# sourceMappingURL=webhooks.d.ts.map