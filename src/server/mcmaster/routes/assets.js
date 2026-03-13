/**
 * Asset catalog routes — ported from Express to Fastify
 */

export default async function assetsRoutes(fastify) {
  // ── GET /api/v1/assets ─────────────────────────────────────────────────────
  fastify.get('/assets', async (req, reply) => {
    const {
      category, type, source,
      status   = 'published',
      limit    = 20,
      offset   = 0,
      sort     = 'created_at',
      order    = 'desc',
    } = req.query

    const allowedSort  = ['created_at', 'name', 'view_count', 'download_count']
    const allowedOrder = ['asc', 'desc']
    const safeSort  = allowedSort.includes(sort)   ? sort  : 'created_at'
    const safeOrder = allowedOrder.includes(order) ? order : 'desc'

    const conditions = ['a.status = $1']
    const params     = [status]
    let   p          = 2

    if (category) { conditions.push(`a.category_id = $${p++}`); params.push(category) }
    if (type)     { conditions.push(`a.asset_type = $${p++}`);  params.push(type) }
    if (source)   { conditions.push(`a.source = $${p++}`);      params.push(source) }

    const where = conditions.join(' AND ')
    params.push(Math.min(Number(limit), 100), Math.max(Number(offset), 0))

    const sql = `
      SELECT a.*, c.name AS category_name, c.slug AS category_slug
      FROM   assets a
      LEFT JOIN categories c ON c.id = a.category_id
      WHERE  ${where}
      ORDER  BY a.${safeSort} ${safeOrder}
      LIMIT  $${p++} OFFSET $${p++}
    `
    const countSql = `SELECT COUNT(*) FROM assets a WHERE ${where}`

    const [rows, count] = await Promise.all([
      fastify.catalog.query(sql,      params.slice(0, -2).concat(params.slice(-2))),
      fastify.catalog.query(countSql, params.slice(0, -2)),
    ])

    return {
      assets: rows.rows,
      pagination: {
        total:  parseInt(count.rows[0].count),
        limit:  Number(limit),
        offset: Number(offset),
      },
    }
  })

  // ── GET /api/v1/assets/:id ──────────────────────────────────────────────────
  fastify.get('/assets/:id', async (req, reply) => {
    const { id } = req.params

    // Support both UUID and slug lookup
    const isUuid = /^[0-9a-f-]{36}$/.test(id)
    const col    = isUuid ? 'a.id' : 'a.slug'

    const { rows } = await fastify.catalog.query(`
      SELECT jsonb_build_object(
        'asset',    to_jsonb(a.*),
        'category', to_jsonb(c.*),
        'learning_materials', (
          SELECT jsonb_agg(to_jsonb(lm.*))
          FROM   learning_materials lm
          WHERE  lm.asset_id = a.id AND lm.status = 'published'
        ),
        'related', (
          SELECT jsonb_agg(jsonb_build_object(
            'type',  ar.relationship_type,
            'asset', to_jsonb(ra.*)
          ))
          FROM   asset_relationships ar
          JOIN   assets ra ON ra.id = ar.to_asset_id
          WHERE  ar.from_asset_id = a.id AND ra.status = 'published'
          LIMIT  6
        )
      ) AS result
      FROM   assets a
      LEFT JOIN categories c ON c.id = a.category_id
      WHERE  ${col} = $1
    `, [id])

    if (!rows.length || !rows[0].result) {
      return reply.status(404).send({ error: 'Asset not found' })
    }

    // Increment view count (fire-and-forget)
    fastify.catalog.query('UPDATE assets SET view_count = view_count + 1 WHERE id = $1',
      [rows[0].result.asset.id]).catch(() => {})

    return rows[0].result
  })

  // ── POST /api/v1/assets ─────────────────────────────────────────────────────
  fastify.post('/assets', async (req, reply) => {
    const {
      part_number, name, description, short_description,
      category_id, tags = [], asset_type = 'product',
      source = 'manual_upload', specifications = {},
      dimensions, material, weight_g,
    } = req.body

    if (!name) return reply.status(400).send({ error: 'name is required' })

    const { rows } = await fastify.catalog.query(`
      INSERT INTO assets (
        part_number, name, description, short_description,
        category_id, tags, asset_type, source,
        specifications, dimensions, material, weight_g,
        status, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft',$13)
      RETURNING *
    `, [
      part_number || null, name, description || null, short_description || null,
      category_id || null, tags, asset_type, source,
      JSON.stringify(specifications), dimensions ? JSON.stringify(dimensions) : null,
      material || null, weight_g || null,
      req.headers['x-user-id'] || 'system',
    ])

    return reply.status(201).send(rows[0])
  })

  // ── PATCH /api/v1/assets/:id ────────────────────────────────────────────────
  fastify.patch('/assets/:id', async (req, reply) => {
    const { id } = req.params
    const updates = req.body

    const allowed = [
      'name', 'description', 'short_description', 'category_id', 'tags',
      'asset_type', 'source', 'specifications', 'dimensions', 'material',
      'weight_g', 'status', 'model_url', 'thumbnail_url',
    ]

    const sets   = []
    const values = []
    let   p      = 1

    for (const key of allowed) {
      if (key in updates) {
        sets.push(`${key} = $${p++}`)
        values.push(typeof updates[key] === 'object'
          ? JSON.stringify(updates[key]) : updates[key])
      }
    }

    if (!sets.length) return reply.status(400).send({ error: 'No valid fields to update' })

    values.push(id)
    const { rows } = await fastify.catalog.query(
      `UPDATE assets SET ${sets.join(', ')} WHERE id = $${p} RETURNING *`,
      values,
    )

    if (!rows.length) return reply.status(404).send({ error: 'Asset not found' })
    return rows[0]
  })

  // ── GET /api/v1/categories ──────────────────────────────────────────────────
  fastify.get('/categories', async () => {
    const { rows } = await fastify.catalog.query(`
      SELECT c.*, COUNT(a.id)::int AS asset_count
      FROM   categories c
      LEFT JOIN assets a ON a.category_id = c.id AND a.status = 'published'
      GROUP  BY c.id
      ORDER  BY c.display_order, c.name
    `)
    return { categories: rows }
  })
}
