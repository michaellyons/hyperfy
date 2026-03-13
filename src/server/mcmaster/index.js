/**
 * McMaster Museum — Catalog API
 *
 * Registered as a Fastify plugin under the `/api/v1` prefix.
 * Uses a dedicated `pg.Pool` (CATALOG_DB_URI) for the product catalog;
 * Hyperfy's own world data stays in the separate DB_URI connection.
 *
 * Routes:
 *   GET  /api/v1/assets                 list / filter assets
 *   GET  /api/v1/assets/:id             single asset + related content
 *   POST /api/v1/assets                 create asset (admin)
 *   GET  /api/v1/search?q=              full-text + semantic search
 *   GET  /api/v1/categories             list all categories
 *   POST /api/v1/ai/generate            start AI 3D generation
 *   GET  /api/v1/ai/:id                 poll generation status
 *
 *   GET  /api/v1/products/:partNumber   live McMaster product lookup
 */

import pg from 'pg'
import assetsRoutes    from './routes/assets.js'
import searchRoutes    from './routes/search.js'
import aiRoutes        from './routes/ai.js'
import productsRoutes  from './routes/products.js'

const { Pool } = pg

export async function mcmasterPlugin(fastify, opts) {
  // ── Catalog DB pool ─────────────────────────────────────────────────────────
  if (!process.env.CATALOG_DB_URI) {
    fastify.log.warn('[mcmaster] CATALOG_DB_URI not set — catalog API disabled')
    return
  }

  const pool = new Pool({ connectionString: process.env.CATALOG_DB_URI })

  // Test connection
  try {
    await pool.query('SELECT 1')
    fastify.log.info('[mcmaster] Catalog DB connected')
  } catch (err) {
    fastify.log.error('[mcmaster] Catalog DB connection failed:', err.message)
    return
  }

  // Decorate fastify so route handlers can access the pool
  fastify.decorate('catalog', pool)

  // Graceful shutdown
  fastify.addHook('onClose', async () => pool.end())

  // ── Register route groups ───────────────────────────────────────────────────
  await fastify.register(assetsRoutes,   { prefix: '/api/v1' })
  await fastify.register(searchRoutes,   { prefix: '/api/v1' })
  await fastify.register(aiRoutes,       { prefix: '/api/v1' })
  await fastify.register(productsRoutes, { prefix: '/api/v1' })

  fastify.log.info('[mcmaster] Catalog API registered at /api/v1')
}
