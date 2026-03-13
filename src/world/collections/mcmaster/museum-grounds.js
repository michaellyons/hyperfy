/**
 * McMaster-Carr Museum — World Grounds
 *
 * This script builds the persistent outdoor environment: terrain, paths,
 * hedge borders and the museum entrance plaza. It is the "base layer" that
 * every world (global or user) loads first.
 *
 * Runs inside Hyperfy's SES sandbox — only the app/world APIs are available.
 */

const GROUND_COLOR   = '#5a8040'
const PATH_COLOR     = '#c8b89a'
const MARBLE_WHITE   = '#f0ede8'
const MARBLE_DARK    = '#d8d0c4'
const GOLD           = '#c8a840'
const HEDGE_COLOR    = '#2d5a1e'
const WATER_COLOR    = '#3a7ab8'
const PILLAR_COLOR   = '#e8e4de'

// ── Ground ────────────────────────────────────────────────────────────────────
const ground = app.create('prim', {
  type: 'box',
  scale: [300, 0.4, 300],
  position: [0, -0.2, 0],
  color: GROUND_COLOR,
  roughness: 0.95,
  physics: 'static',
})
app.add(ground)

// ── Central approach path from spawn to museum entrance ──────────────────────
const approachPath = app.create('prim', {
  type: 'box',
  scale: [8, 0.05, 60],
  position: [0, 0.02, 20],
  color: PATH_COLOR,
  roughness: 0.8,
  physics: 'static',
})
app.add(approachPath)

// ── Museum entrance plaza ─────────────────────────────────────────────────────
const plaza = app.create('prim', {
  type: 'box',
  scale: [40, 0.15, 20],
  position: [0, 0.07, -10],
  color: MARBLE_WHITE,
  roughness: 0.3,
  metalness: 0.05,
  physics: 'static',
})
app.add(plaza)

// ── Entrance steps (3 tiers) ──────────────────────────────────────────────────
for (let i = 0; i < 3; i++) {
  const step = app.create('prim', {
    type: 'box',
    scale: [20 - i * 4, 0.25, 2],
    position: [0, 0.25 + i * 0.25, -1 + i * 2],
    color: MARBLE_WHITE,
    roughness: 0.25,
    physics: 'static',
  })
  app.add(step)
}

// ── Entrance columns (6 columns across the front) ────────────────────────────
const COL_SPACING = 3.5
const COL_OFFSET  = -(COL_SPACING * 2.5)
for (let i = 0; i < 6; i++) {
  const x = COL_OFFSET + i * COL_SPACING

  // Shaft
  const col = app.create('prim', {
    type: 'cylinder',
    scale: [0.45, 8, 0.45],
    position: [x, 4, -19],
    color: PILLAR_COLOR,
    roughness: 0.3,
    physics: 'static',
  })
  app.add(col)

  // Capital
  const cap = app.create('prim', {
    type: 'box',
    scale: [0.7, 0.4, 0.7],
    position: [x, 8.2, -19],
    color: MARBLE_DARK,
    roughness: 0.4,
    physics: 'static',
  })
  app.add(cap)

  // Base
  const base = app.create('prim', {
    type: 'box',
    scale: [0.65, 0.3, 0.65],
    position: [x, 0.15, -19],
    color: MARBLE_DARK,
    roughness: 0.4,
    physics: 'static',
  })
  app.add(base)
}

// ── Entablature (lintel across columns) ──────────────────────────────────────
const lintel = app.create('prim', {
  type: 'box',
  scale: [20, 0.8, 0.9],
  position: [0, 8.6, -19],
  color: MARBLE_WHITE,
  roughness: 0.3,
  physics: 'static',
})
app.add(lintel)

// ── Pediment (triangular gable) ──────────────────────────────────────────────
const pediment = app.create('prim', {
  type: 'cone',
  scale: [10, 2.5, 0.9],
  position: [0, 10.25, -19],
  color: MARBLE_WHITE,
  roughness: 0.3,
  physics: 'static',
})
app.add(pediment)

// ── Hedge borders along the approach path ────────────────────────────────────
for (let side of [-1, 1]) {
  for (let seg = 0; seg < 6; seg++) {
    const hedge = app.create('prim', {
      type: 'box',
      scale: [1.2, 1.8, 8],
      position: [side * 6.5, 0.9, 10 + seg * 8.5],
      color: HEDGE_COLOR,
      roughness: 0.95,
      physics: 'static',
    })
    app.add(hedge)
  }
}

// ── Fountain at the centre of the approach ────────────────────────────────────
const fountainBase = app.create('prim', {
  type: 'cylinder',
  scale: [4, 0.5, 4],
  position: [0, 0.25, 30],
  color: MARBLE_WHITE,
  roughness: 0.3,
  physics: 'static',
})
app.add(fountainBase)

const fountainWater = app.create('prim', {
  type: 'cylinder',
  scale: [3.2, 0.25, 3.2],
  position: [0, 0.55, 30],
  color: WATER_COLOR,
  roughness: 0.1,
  metalness: 0.3,
  physics: 'static',
})
app.add(fountainWater)

const fountainPillar = app.create('prim', {
  type: 'cylinder',
  scale: [0.25, 2.5, 0.25],
  position: [0, 1.75, 30],
  color: MARBLE_WHITE,
  roughness: 0.3,
  physics: 'static',
})
app.add(fountainPillar)

const fountainTop = app.create('prim', {
  type: 'sphere',
  scale: [0.6, 0.6, 0.6],
  position: [0, 3.2, 30],
  color: GOLD,
  roughness: 0.2,
  metalness: 0.8,
})
app.add(fountainTop)

// Animate fountain top (gentle spin)
app.on('update', dt => {
  fountainTop.rotation.y += dt * 0.4
})

console.log('[McMaster Museum] Grounds loaded')
