/**
 * Live McMaster-Carr product lookup routes
 * Fetches real-time data from the McMaster API and optionally caches to catalog DB.
 */

import { McMasterClient } from '../client.js'

let _client = null

function getClient() {
  if (_client) return _client

  const { MCMASTER_USERNAME, MCMASTER_PASSWORD, MCMASTER_CERT_PATH, MCMASTER_CERT_PASSWORD } = process.env

  if (!MCMASTER_USERNAME || !MCMASTER_PASSWORD) return null

  _client = new McMasterClient({
    username:     MCMASTER_USERNAME,
    password:     MCMASTER_PASSWORD,
    certPath:     MCMASTER_CERT_PATH     || '',
    certPassword: MCMASTER_CERT_PASSWORD || '',
  })

  return _client
}

export default async function productsRoutes(fastify) {
  // ── GET /api/v1/products/:partNumber ────────────────────────────────────────
  fastify.get('/products/:partNumber', async (req, reply) => {
    const { partNumber } = req.params
    const client = getClient()

    if (!client) {
      return reply.status(503).send({
        error: 'McMaster API not configured. Set MCMASTER_USERNAME + MCMASTER_PASSWORD.',
      })
    }

    // Check catalog cache first
    const cached = await fastify.catalog.query(
      `SELECT * FROM assets WHERE part_number = $1 AND source = 'mcmaster' LIMIT 1`,
      [partNumber],
    )
    if (cached.rows.length && req.query.cache !== 'false') {
      return { source: 'cache', asset: cached.rows[0] }
    }

    try {
      if (!client.isAuthenticated()) await client.login()

      const product = await client.getProductData(partNumber)

      // Upsert into catalog for future use
      const { rows } = await fastify.catalog.query(`
        INSERT INTO assets (
          part_number, name, description, specifications,
          source, asset_type, status
        )
        VALUES ($1,$2,$3,$4,'mcmaster','product','published')
        ON CONFLICT (part_number) DO UPDATE SET
          name           = EXCLUDED.name,
          description    = EXCLUDED.description,
          specifications = EXCLUDED.specifications,
          updated_at     = NOW()
        RETURNING *
      `, [
        product.PartNumber,
        product.ProductName,
        product.Description,
        JSON.stringify(Object.fromEntries(
          (product.Specifications ?? []).map(s => [s.Name, `${s.Value}${s.Unit ? ' ' + s.Unit : ''}`]),
        )),
      ])

      return { source: 'live', asset: rows[0], raw: product }
    } catch (err) {
      fastify.log.error('[mcmaster] product lookup failed:', err.message)
      return reply.status(502).send({ error: 'McMaster API error', detail: err.message })
    }
  })

  // ── GET /api/v1/products/:partNumber/cad ────────────────────────────────────
  fastify.get('/products/:partNumber/cad', async (req, reply) => {
    const { partNumber } = req.params
    const { format = 'STEP' } = req.query
    const client = getClient()

    if (!client) return reply.status(503).send({ error: 'McMaster API not configured' })

    try {
      if (!client.isAuthenticated()) await client.login()
      const blob = await client.getCADFile(partNumber, format.toUpperCase())
      const buf  = Buffer.from(await blob.arrayBuffer())

      reply.header('Content-Type', 'application/octet-stream')
      reply.header('Content-Disposition', `attachment; filename="${partNumber}.${format.toLowerCase()}"`)
      return reply.send(buf)
    } catch (err) {
      return reply.status(502).send({ error: 'CAD download failed', detail: err.message })
    }
  })
}
