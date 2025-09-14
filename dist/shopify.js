const API_VERSION = "2025-04";
/**
 * Fetch JSON from Shopify Admin REST API.
 * Uses global fetch (Node 18+). If you run older Node, install node-fetch.
 */
async function shopifyFetch(client, path, query = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
        if (v !== undefined)
            q.set(k, String(v));
    const url = `https://${client.shop}/admin/api/${client.apiVersion ?? API_VERSION}/${path}.json${q.toString() ? `?${q.toString()}` : ""}`;
    const res = await fetch(url, {
        headers: {
            "X-Shopify-Access-Token": client.accessToken,
            Accept: "application/json",
        },
    });
    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Shopify ${path} ${res.status}: ${txt}`);
    }
    const body = (await res.json());
    return { body, headers: res.headers };
}
/**
 * Extract next page_info from Link header (if present).
 */
function extractNextPageInfo(linkHeader) {
    if (!linkHeader)
        return undefined;
    // match rel="next"
    const match = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/i);
    return match ? match[1] : undefined;
}
/**
 * Generic paginator for endpoints that return { products: [...] } or { customers: [...] } etc.
 * `rootKey` is the key in the JSON response that contains the array (e.g. "products" / "customers" / "orders")
 */
async function paginateAll(client, path, rootKey, extraQuery = {}) {
    const all = [];
    let pageInfo = undefined;
    while (true) {
        const query = { limit: 250, ...extraQuery };
        if (pageInfo)
            query.page_info = pageInfo;
        const { body, headers } = await shopifyFetch(client, path, query);
        const items = body[rootKey] ?? [];
        all.push(...items);
        const link = headers.get("link");
        const next = extractNextPageInfo(link);
        if (!next)
            break;
        pageInfo = next;
    }
    return all;
}
export function makeClient(shop, accessToken) {
    return { shop, accessToken, apiVersion: API_VERSION };
}
export async function fetchAllProducts(client) {
    return paginateAll(client, "products", "products");
}
export async function fetchAllCustomers(client) {
    return paginateAll(client, "customers", "customers");
}
export async function fetchAllOrders(client) {
    // include status=any to get all orders
    return paginateAll(client, "orders", "orders", { status: "any" });
}
//# sourceMappingURL=shopify.js.map