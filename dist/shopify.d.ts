type ShopifyClient = {
    shop: string;
    accessToken: string;
    apiVersion?: string;
};
export declare function makeClient(shop: string, accessToken: string): ShopifyClient;
export declare function fetchAllProducts(client: ShopifyClient): Promise<any[]>;
export declare function fetchAllCustomers(client: ShopifyClient): Promise<any[]>;
export declare function fetchAllOrders(client: ShopifyClient): Promise<any[]>;
export {};
//# sourceMappingURL=shopify.d.ts.map