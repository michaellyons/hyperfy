/**
 * Search routes — full-text and semantic (pgvector) asset search
 */

export default async function searchRoutes(fastify) {
  // ── GET /api/v1/search ──────────────────────────────────────────────────────
  fastify.get('/search', async (req, reply) => {
    const {
      q, category, type, tags,
      limit  = 20,
      offset = 0,
      mode   = 'fulltext',  // 'fulltext' | 'semantic'
    } = req.query

    if (!q || q.length < 1) return reply.status(400).send({ error: 'q is required' })

    const safeLimit  = Math.min(Number(limit),  100)
    const safeOffset = Math.max(Number(offset), 0)

    if (mode === 'semantic' && process.env.OPENAI_API_KEY) {
      return semanticSearch(fastify, { q, category, type, safeLimit, safeOffset }, reply)
    }

    // Full-text search using PostgreSQL tsvector
    const conditions = [`a.status = 'published'`, `a.search_vector @@ plainto_tsquery('english', $1)`]
    const params     = [q]
    let   p          = 2

    if (category) { conditions.push(`a.category_id = $${p++}`); params.push(category) }
    if (type)     { conditions.push(`a.asset_type = $${p++}`);  params.push(type) }
    if (tags)     {
      const tagList = tags.split(',').map(t => t.trim()).filter(Boolean)
      if (tagList.length) {
        conditions.push(`a.tags && $${p++}::text[]`)
        params.push(tagList)
      }
    }

    const where = conditions.join(' AND ')
    params.push(safeLimit, safeOffset)

    const { rows } = await fastify.catalog.query(`
      SELECT
        a.*,
        c.name AS category_name,
        ts_rank(a.search_vector, plainto_tsquery('english', $1)) AS rank
      FROM   assets a
      LEFT JOIN categories c ON c.id = a.category_id
      WHERE  ${where}
      ORDER  BY rank DESC
      LIMIT  $${p++} OFFSET $${p++}
    `, params)

    const { rows: countRows } = await fastify.catalog.query(
      `SELECT COUNT(*) FROM assets a WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2),
    )

    return {
      query:      q,
      mode:       'fulltext',
      results:    rows,
      pagination: {
        total:  parseInt(countRows[0].count),
        limit:  safeLimit,
        offset: safeOffset,
      },
    }
  })

  // ── GET /api/v1/search/suggest ──────────────────────────────────────────────
  fastify.get('/search/suggest', async (req, reply) => {
    const { q } = req.query
    if (!q || q.length < 2) return { suggestions: [] }

    const { rows } = await fastify.catalog.query(`
      SELECT name, slug, asset_type
      FROM   assets
      WHERE  status = 'published'
        AND  name ILIKE $1
      ORDER  BY view_count DESC
      LIMIT  8
    `, [`${q}%`])

    return { suggestions: rows }
  })
}

// ── Semantic search via OpenAI embeddings + pgvector ─────────────────────────
async function semanticSearch(fastify, { q, category, type, safeLimit, safeOffset }, reply) {
  try {
    const { OpenAI } = await import('openai')
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

    const embedding = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: q,
    })

    const vector = `[${embedding.data[0].embedding.join(',')}]`

    const conditions = [`a.status = 'published'`, `1 - (ae.embedding <=> $1::vector) > 0.65`]
    const params     = [vector]
    let   p          = 2

    if (category) { conditions.push(`a.category_id = $${p++}`); params.push(category) }
    if (type)     { conditions.push(`a.asset_type = $${p++}`);  params.push(type) }

    params.push(safeLimit, safeOffset)

    const { rows } = await fastify.catalog.query(`
      SELECT
        a.*,
        c.name AS category_name,
        1 - (ae.embedding <=> $1::vector) AS similarity
      FROM   asset_embeddings ae
      JOIN   assets a ON a.id = ae.asset_id
      LEFT JOIN categories c ON c.id = a.category_id
      WHERE  ${conditions.join(' AND ')}
      ORDER  BY ae.embedding <=> $1::vector
      LIMIT  $${p++} OFFSET $${p++}
    `, params)

    return {
      query:   q,
      mode:    'semantic',
      results: rows,
      pagination: { total: rows.length, limit: safeLimit, offset: safeOffset },
    }
  } catch (err) {
    fastify.log.error('Semantic search failed:', err.message)
    return reply.status(500).send({ error: 'Semantic search failed', detail: err.message })
  }
}
