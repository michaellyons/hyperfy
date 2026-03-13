/**
 * McMaster-Carr Museum — Interactive Display Case
 *
 * A glass-topped pedestal that shows a rotating product. Admins can configure:
 *   - productName   : product label shown above the case
 *   - productColor  : hex color of the displayed object
 *   - productShape  : box | sphere | cylinder | cone
 *   - partNumber    : McMaster part number
 *
 * Players can click the case to see the product detail panel.
 */

app.configure([
  { type: 'text',   key: 'productName',  label: 'Product Name',  initial: 'Hex Bolt Grade 8' },
  { type: 'text',   key: 'partNumber',   label: 'Part Number',   initial: '91247A553' },
  { type: 'select', key: 'productShape', label: 'Shape',         initial: 'cylinder',
    options: [
      { label: 'Cylinder',  value: 'cylinder' },
      { label: 'Box',       value: 'box' },
      { label: 'Sphere',    value: 'sphere' },
      { label: 'Cone',      value: 'cone' },
    ]
  },
  { type: 'text', key: 'productColor', label: 'Product Color (hex)', initial: '#888888' },
])

const MARBLE_WHITE = '#f0ede8'
const GLASS_COLOR  = '#a8d0e8'
const GOLD         = '#c8a840'

// ── Pedestal ──────────────────────────────────────────────────────────────────
const pedestal = app.create('prim', {
  type: 'box',
  scale: [1.2, 1.0, 1.2],
  position: [0, 0.5, 0],
  color: MARBLE_WHITE,
  roughness: 0.25,
  physics: 'static',
})
app.add(pedestal)

// Gold trim ring
const trim = app.create('prim', {
  type: 'cylinder',
  scale: [0.7, 0.08, 0.7],
  position: [0, 1.04, 0],
  color: GOLD,
  metalness: 0.9,
  roughness: 0.1,
  physics: 'static',
})
app.add(trim)

// ── Glass case ────────────────────────────────────────────────────────────────
const glassBody = app.create('prim', {
  type: 'box',
  scale: [1.0, 0.9, 1.0],
  position: [0, 1.5, 0],
  color: GLASS_COLOR,
  opacity: 0.18,
  roughness: 0.02,
  metalness: 0.1,
})
app.add(glassBody)

const glassLid = app.create('prim', {
  type: 'box',
  scale: [1.05, 0.06, 1.05],
  position: [0, 1.97, 0],
  color: MARBLE_WHITE,
  roughness: 0.3,
  physics: 'static',
})
app.add(glassLid)

// ── Product object ────────────────────────────────────────────────────────────
const product = app.create('prim', {
  type: props.productShape || 'cylinder',
  scale: [0.28, 0.28, 0.28],
  position: [0, 1.5, 0],
  color: props.productColor || '#888888',
  roughness: 0.4,
  metalness: 0.6,
})
app.add(product)

// ── Label panel ───────────────────────────────────────────────────────────────
const label = app.create('prim', {
  type: 'box',
  scale: [0.9, 0.14, 0.04],
  position: [0, 0.86, 0.62],
  color: '#222222',
  roughness: 0.9,
  physics: 'static',
})
app.add(label)

// ── Interaction trigger ───────────────────────────────────────────────────────
const trigger = app.create('trigger', {
  type: 'box',
  scale: [2.0, 2.5, 2.0],
  position: [0, 1.0, 0],
})
app.add(trigger)

// ── Animation & interaction ───────────────────────────────────────────────────
let spinAngle = 0

app.on('update', dt => {
  spinAngle += dt * 0.8
  product.rotation.y = spinAngle
})

app.on('trigger/enter', ({ player }) => {
  if (world.isServer) {
    app.sendTo(player.id, 'show-panel', {
      name:        props.productName  || 'Product',
      partNumber:  props.partNumber   || '—',
      shape:       props.productShape || 'cylinder',
      color:       props.productColor || '#888888',
    })
  }
})

app.on('trigger/leave', ({ player }) => {
  if (world.isServer) {
    app.sendTo(player.id, 'hide-panel', {})
  }
})

if (world.isClient) {
  app.on('show-panel', data => {
    window.dispatchEvent(new CustomEvent('museum:product', { detail: data }))
  })
  app.on('hide-panel', () => {
    window.dispatchEvent(new CustomEvent('museum:product-hide'))
  })
}

console.log('[Display Case] Loaded:', props.productName)
