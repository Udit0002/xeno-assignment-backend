// src/shopify.ts
type ShopifyClient = {
  shop: string;        // e.g. swjgbi-rf.myshopify.com
  accessToken: string; // Admin API access token (shpat_...)
  apiVersion?: string; // default "2025-04"
};

const API_VERSION = "2025-04";

/**
 * Fetch JSON from Shopify Admin REST API.
 * Uses global fetch (Node 18+). If you run older Node, install node-fetch.
 */
async function shopifyFetch<T = any>(
  client: ShopifyClient,
  path: string,
  query: Record<string, string | number | undefined> = {}
): Promise<{ body: T; headers: Headers }> {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
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
  const body = (await res.json()) as T;
  return { body, headers: res.headers };
}

/**
 * Extract next page_info from Link header (if present).
 */
function extractNextPageInfo(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  // match rel="next"
  const match = linkHeader.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/i);
  return match ? match[1] : undefined;
}

/**
 * Generic paginator for endpoints that return { products: [...] } or { customers: [...] } etc.
 * `rootKey` is the key in the JSON response that contains the array (e.g. "products" / "customers" / "orders")
 */
async function paginateAll(client: ShopifyClient, path: string, rootKey: string, extraQuery: Record<string, any> = {}) {
  const all: any[] = [];
  let pageInfo: string | undefined = undefined;
  while (true) {
    const query: Record<string, any> = { limit: 250, ...extraQuery };
    if (pageInfo) query.page_info = pageInfo;
    const { body, headers } = await shopifyFetch<any>(client, path, query);
    const items = body[rootKey] ?? [];
    all.push(...items);
    const link = headers.get("link");
    const next = extractNextPageInfo(link);
    if (!next) break;
    pageInfo = next;
  }
  return all;
}

export function makeClient(shop: string, accessToken: string): ShopifyClient {
  return { shop, accessToken, apiVersion: API_VERSION };
}

export async function fetchAllProducts(client: ShopifyClient) {
  return paginateAll(client, "products", "products");
}

export async function fetchAllCustomers(client: ShopifyClient) {
  return paginateAll(client, "customers", "customers");
}

export async function fetchAllOrders(client: ShopifyClient) {
  // include status=any to get all orders
  return paginateAll(client, "orders", "orders", { status: "any" });
}
