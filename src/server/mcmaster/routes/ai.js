/**
 * AI 3D generation routes — Tripo3D / Meshy
 */

const PROVIDERS = {
  tripo3d: {
    baseUrl:      'https://api.tripo3d.ai/v1',
    envKey:       'TRIPO3D_API_KEY',
    costPerJob:   0.50,
    qualityScore: 5,
  },
  meshy: {
    baseUrl:      'https://api.meshy.ai/v2',
    envKey:       'MESHY_API_KEY',
    costPerJob:   0.20,
    qualityScore: 4,
  },
}

function selectProvider(style) {
  // Pick highest quality provider with a valid API key
  const available = Object.entries(PROVIDERS)
    .filter(([, cfg]) => !!process.env[cfg.envKey])
    .sort(([, a], [, b]) => b.qualityScore - a.qualityScore)

  return available[0]?.[0] ?? null
}

export default async function aiRoutes(fastify) {
  // ── POST /api/v1/ai/generate ────────────────────────────────────────────────
  fastify.post('/ai/generate', async (req, reply) => {
    const {
      prompt, negative_prompt, reference_image_url,
      style            = 'technical',
      provider: reqProv = 'auto',
      wait_for_result  = false,
    } = req.body

    if (!prompt) return reply.status(400).send({ error: 'prompt is required' })

    const provider = reqProv === 'auto' ? selectProvider(style) : reqProv
    if (!provider || !PROVIDERS[provider]) {
      return reply.status(400).send({
        error: 'No AI provider available. Set TRIPO3D_API_KEY or MESHY_API_KEY.',
      })
    }

    // Create DB record
    const { rows } = await fastify.catalog.query(`
      INSERT INTO ai_generations (
        provider, prompt, negative_prompt, reference_image_url,
        style, status, created_by
      ) VALUES ($1,$2,$3,$4,$5,'pending',$6)
      RETURNING *
    `, [provider, prompt, negative_prompt || null, reference_image_url || null, style,
        req.headers['x-user-id'] || 'system'])

    const job = rows[0]

    // Kick off generation in background
    triggerGeneration(fastify, job).catch(err => {
      fastify.log.error(`[ai] generation ${job.id} failed:`, err.message)
    })

    if (wait_for_result) {
      const result = await pollUntilDone(fastify, job.id, 120_000)
      return result
    }

    return reply.status(202).send({
      id:     job.id,
      status: 'pending',
      message: `Generation started. Poll GET /api/v1/ai/${job.id} for status.`,
    })
  })

  // ── GET /api/v1/ai/:id ──────────────────────────────────────────────────────
  fastify.get('/ai/:id', async (req, reply) => {
    const { rows } = await fastify.catalog.query(
      'SELECT * FROM ai_generations WHERE id = $1', [req.params.id],
    )
    if (!rows.length) return reply.status(404).send({ error: 'Generation not found' })
    return rows[0]
  })

  // ── GET /api/v1/ai (list recent) ────────────────────────────────────────────
  fastify.get('/ai', async (req) => {
    const { status, limit = 20, offset = 0 } = req.query
    const conditions = []
    const params = []
    let p = 1

    if (status) { conditions.push(`status = $${p++}`); params.push(status) }
    params.push(Math.min(Number(limit), 100), Math.max(Number(offset), 0))

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const { rows } = await fastify.catalog.query(
      `SELECT * FROM ai_generations ${where} ORDER BY created_at DESC LIMIT $${p++} OFFSET $${p++}`,
      params,
    )
    return { generations: rows }
  })
}

// ── Background generation logic ────────────────────────────────────────────────
async function triggerGeneration(fastify, job) {
  const cfg = PROVIDERS[job.provider]
  if (!cfg) throw new Error(`Unknown provider: ${job.provider}`)

  const apiKey = process.env[cfg.envKey]
  if (!apiKey) throw new Error(`${cfg.envKey} not set`)

  await fastify.catalog.query(
    `UPDATE ai_generations SET status = 'processing' WHERE id = $1`, [job.id],
  )

  let externalId
  const start = Date.now()

  try {
    if (job.provider === 'tripo3d') {
      externalId = await startTripo3D(apiKey, job)
    } else if (job.provider === 'meshy') {
      externalId = await startMeshy(apiKey, job)
    }

    // Poll external provider (max 5 min)
    const result = await pollProvider(job.provider, apiKey, externalId, 300_000)

    await fastify.catalog.query(`
      UPDATE ai_generations
      SET status = 'completed', result_model_url = $2, result_thumbnail_url = $3,
          progress_percent = 100, processing_time_ms = $4, completed_at = NOW()
      WHERE id = $1
    `, [job.id, result.modelUrl, result.thumbnailUrl, Date.now() - start])
  } catch (err) {
    await fastify.catalog.query(`
      UPDATE ai_generations
      SET status = 'failed', error_message = $2
      WHERE id = $1
    `, [job.id, err.message])
    throw err
  }
}

async function startTripo3D(apiKey, job) {
  const body = {
    type:   'text_to_model',
    prompt: job.prompt,
    ...(job.negative_prompt && { negative_prompt: job.negative_prompt }),
    ...(job.reference_image_url && {
      type: 'image_to_model',
      file: { type: 'url', url: job.reference_image_url },
    }),
  }

  const res = await fetch('https://api.tripo3d.ai/v2/openapi/task', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body:    JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message ?? 'Tripo3D API error')
  return data.data.task_id
}

async function startMeshy(apiKey, job) {
  const res = await fetch('https://api.meshy.ai/openapi/v2/text-to-3d', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body:    JSON.stringify({
      mode:   'preview',
      prompt: job.prompt,
      ...(job.negative_prompt && { negative_prompt: job.negative_prompt }),
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.message ?? 'Meshy API error')
  return data.result
}

async function pollProvider(provider, apiKey, externalId, timeoutMs) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 4000))

    let modelUrl, thumbnailUrl, status

    if (provider === 'tripo3d') {
      const res  = await fetch(`https://api.tripo3d.ai/v2/openapi/task/${externalId}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` } })
      const data = await res.json()
      status      = data.data.status
      modelUrl    = data.data.output?.model
      thumbnailUrl = data.data.output?.rendered_image
    } else {
      const res  = await fetch(`https://api.meshy.ai/openapi/v2/text-to-3d/${externalId}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` } })
      const data = await res.json()
      status      = data.status
      modelUrl    = data.model_urls?.glb
      thumbnailUrl = data.thumbnail_url
    }

    if (['SUCCEEDED', 'COMPLETED', 'success'].includes(status)) {
      return { modelUrl, thumbnailUrl }
    }
    if (['FAILED', 'CANCELLED', 'error'].includes(status)) {
      throw new Error(`Generation ${status}`)
    }
  }
  throw new Error('Generation timed out')
}

async function pollUntilDone(fastify, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000))
    const { rows } = await fastify.catalog.query(
      'SELECT * FROM ai_generations WHERE id = $1', [jobId],
    )
    const job = rows[0]
    if (!job) throw new Error('Job not found')
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job
  }
  throw new Error('Timed out waiting for generation')
}
