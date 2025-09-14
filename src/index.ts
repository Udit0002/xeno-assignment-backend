// src/index.ts
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { prisma } from './prisma.js';
import { fullSync } from './sync.js';
import { verifyHmac, processWebhookPayload } from './webhooks.js';
import { registerWebhooks } from './webhookRegister.js';
import cron from "node-cron";
import { makeClient, fetchAllCustomers } from './shopify.js';


dotenv.config();
const app = express();
const PORT = process.env.PORT || 4000;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "supersecret123";
const DEFAULT_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || "whsec_default";
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "*/15 * * * *";

/**
 * CORS - allow your frontend origins (adjust or add more origins as needed)
 * For local dev we allow http://localhost:3000 and 127.0.0.1:3000.
 * Add your ngrok URL here if you test from browser via ngrok.
 */
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  // Add your current ngrok URL if you open frontend via ngrok:
  // "https://f86e1393823b.ngrok-free.app"
];

app.use(cors({
  origin: (origin, callback) => {
    // allow requests with no origin (e.g. curl, Postman, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error("CORS not allowed by server"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-key", "X-Shopify-Hmac-Sha256", "X-Shopify-Topic", "X-Shopify-Shop-Domain"]
}));

/**
 * Capture raw body for HMAC verification while still populating req.body.
 * The `verify` hook gives us the raw buffer which we store on req.rawBody.
 */
app.use(express.json({
  verify: (req: any, _res, buf: Buffer) => {
    if (buf && buf.length) (req as any).rawBody = Buffer.from(buf);
  }
}));

/**
 * Webhook handler
 * - Uses req.rawBody (Buffer) to verify HMAC
 * - Uses parsed req.body (object) for processing
 */
app.post("/api/webhooks/shopify", async (req, res) => {
  try {
    const raw = (req as any).rawBody as Buffer | undefined;
    const hmac = (req.headers["x-shopify-hmac-sha256"] || "") as string;
    const shop = (req.headers["x-shopify-shop-domain"] || "") as string;
    const topic = (req.headers["x-shopify-topic"] || "") as string;

    if (!shop) return res.status(400).send("missing shop header");
    if (!raw) {
      console.warn("Missing raw body for webhook (ensure express.json verify is active)");
      return res.status(400).send("missing raw body");
    }

    // get tenant secret (per-tenant) or fall back to default
    const tenant = await prisma.tenant.findUnique({ where: { shop } });
    const secret = tenant?.webhookSecret ?? DEFAULT_WEBHOOK_SECRET;

    if (!verifyHmac(raw, hmac, secret)) {
      console.warn("Invalid webhook HMAC for shop", shop);
      return res.status(401).send("invalid hmac");
    }

    // parsed payload (express.json already parsed it)
    const payload = req.body;
    await processWebhookPayload(topic, shop, payload);

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Webhook handling error:", err);
    return res.status(500).send("error");
  }
});

// Health check
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

// list tenants (admin)
app.get("/api/tenants", async (_req, res) => {
  const tenants = await prisma.tenant.findMany({ select: { id: true, shop: true, createdAt: true } });
  res.json(tenants);
});

// Onboard tenant (requires API key). Optionally pass ngrokUrl to auto-register webhooks.
app.post("/api/tenants/onboard", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== ADMIN_API_KEY) return res.status(403).json({ error: "forbidden" });

  const { shop, accessToken, webhookSecret, ngrokUrl } = req.body;
  if (!shop || !accessToken) return res.status(400).json({ error: "shop and accessToken required" });

  try {
    const tenant = await prisma.tenant.upsert({
      where: { shop },
      update: { accessToken, webhookSecret },
      create: { shop, accessToken, webhookSecret },
    });

    // If caller provided a public URL (ngrok or deployed URL), auto-register webhooks
    if (ngrokUrl) {
      try {
        const results = await registerWebhooks(tenant.shop, tenant.accessToken as string, ngrokUrl);
        console.log("webhook registration results:", results);
      } catch (e) {
        console.warn("webhook registration failed:", e);
      }
    }

    res.json(tenant);
  } catch (err) {
    console.error("onboard error:", err);
    res.status(500).json({ error: "internal" });
  }
});

// Manual sync
app.post("/api/:tenantId/sync", async (req, res) => {
  try {
    const { tenantId } = req.params;
    const stats = await fullSync(tenantId);
    res.json({ status: "ok", ...stats });
  } catch (err: any) {
    console.error("sync error", err);
    res.status(500).json({ error: err.message || "sync failed" });
  }
});

// Metrics summary
app.get("/api/:tenantId/metrics/summary", async (req, res) => {
  try {
    const { tenantId } = req.params;
    const totalCustomers = await prisma.customer.count({ where: { tenantId } });
    const totalOrders = await prisma.order.count({ where: { tenantId } });
    const revenueAgg = await prisma.order.aggregate({ where: { tenantId }, _sum: { totalPrice: true } });
    res.json({ totalCustomers, totalOrders, totalRevenue: revenueAgg._sum.totalPrice ?? 0 });
  } catch (err: any) {
    console.error("metrics summary error:", err);
    res.status(500).json({ error: err.message || "failed" });
  }
});

// Top customers by spend
// Top customers by spend (normalized output)
app.get("/api/:tenantId/customers/top", async (req, res) => {
  try {
    const { tenantId } = req.params;
    const limit = Number(req.query.limit ?? 5);

    // get customerId groups sorted by total spent
    const topCustomers = await prisma.order.groupBy({
      by: ["customerId"],
      where: { tenantId, customerId: { not: null } },
      _sum: { totalPrice: true },
      orderBy: { _sum: { totalPrice: "desc" } },
      take: limit,
    });

    const results: Array<{
      id: string;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      shopifyCustomerId: string | null;
      totalSpend: number;
    }> = [];

    for (const group of topCustomers) {
      if (!group.customerId) continue;

      // explicitly select the fields we expect
      const cust = await prisma.customer.findUnique({
        where: { id: group.customerId },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          shopifyCustomerId: true,
        },
      });

      // If customer record missing, skip (or create a minimal fallback)
      if (!cust) continue;

      // _sum.totalPrice may be string or Decimal — coerce to number safely
      const total = group._sum?.totalPrice ?? 0;
      const totalNum = typeof total === "string" ? Number(total) : Number(total ?? 0);

      results.push({
        id: cust.id,
        firstName: cust.firstName ?? null,
        lastName: cust.lastName ?? null,
        email: cust.email ?? null,
        shopifyCustomerId: cust.shopifyCustomerId ?? null,
        totalSpend: Number.isFinite(totalNum) ? totalNum : 0,
      });
    }

    res.json(results);
  } catch (err: any) {
    console.error("top customers error:", err);
    res.status(500).json({ error: err.message || "failed" });
  }
});


// Orders by date
app.get("/api/:tenantId/orders/by-date", async (req, res) => {
  try {
    const { tenantId } = req.params;
    const startParam = req.query.start ? String(req.query.start) : undefined;
    const endParam = req.query.end ? String(req.query.end) : undefined;

    const where: any = { tenantId };
    if (startParam || endParam) {
      where.createdAt = {};
      if (startParam) where.createdAt.gte = new Date(startParam + "T00:00:00.000Z");
      if (endParam) where.createdAt.lte = new Date(endParam + "T23:59:59.999Z");
    }

    const orders = await prisma.order.findMany({
      where,
      select: { createdAt: true, totalPrice: true },
      orderBy: { createdAt: "asc" },
    });

    const grouped: Record<string, number> = {};
    for (const o of orders) {
      if (!o.createdAt) continue;
      const d = o.createdAt.toISOString().split("T")[0];
      grouped[d] = (grouped[d] || 0) + Number(o.totalPrice);
    }
    res.json(grouped);
  } catch (err: any) {
    console.error("orders by date error:", err);
    res.status(500).json({ error: err.message || "failed" });
  }
});

// Scheduler: runs every CRON_SCHEDULE (default every 15 minutes)
cron.schedule(CRON_SCHEDULE, async () => {
  console.log("⏰ Scheduled sync start");
  const tenants = await prisma.tenant.findMany({ select: { id: true, shop: true } });
  for (const t of tenants) {
    try {
      await fullSync(t.id);
      console.log(`Synced tenant ${t.shop}`);
    } catch (e) {
      console.error(`Scheduled sync failed for ${t.shop}`, e);
    }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});

// Manual endpoint: sync only customers
app.post("/api/:tenantId/sync-customers", async (req, res) => {
  try {
    const { tenantId } = req.params;
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) return res.status(404).json({ error: "tenant not found" });

    const client = makeClient(tenant.shop, tenant.accessToken);

    const customers = await fetchAllCustomers(client);

    for (const c of customers) {
      const shopifyCustomerId = String(c.id);
      const data = {
  email: c.email ?? null,
  firstName: c.first_name ?? c.default_address?.first_name ?? null,
  lastName: c.last_name ?? c.default_address?.last_name ?? null,
  createdAt: c.created_at ? new Date(c.created_at) : undefined,
  updatedAt: c.updated_at ? new Date(c.updated_at) : undefined,
};


      await prisma.customer.upsert({
        where: { tenantId_shopifyCustomerId: { tenantId, shopifyCustomerId } as any },
        update: data,
        create: { tenantId, shopifyCustomerId, ...data },
      });
    }

    // fetch back everything from DB to return
    const dbCustomers = await prisma.customer.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
    });

    res.json({ status: "ok", customers: dbCustomers });
  } catch (err: any) {
    console.error("sync-customers error:", err);
    res.status(500).json({ error: err.message || "failed" });
  }
});
