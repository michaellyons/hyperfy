import { isBoolean, isNumber, isString } from 'lodash-es'
import * as THREE from '../extras/three'
import { Node } from './Node'

const defaults = {
  videoUrl: null,
  dataUrl: null,
  loop: true,
  autoplay: true,
  volume: 1,
}

export class Volumetric extends Node {
  constructor(data = {}) {
    super(data)
    this.name = 'volumetric'

    this.videoUrl = data.videoUrl
    this.dataUrl = data.dataUrl
    this.loop = data.loop
    this.autoplay = data.autoplay
    this.volume = data.volume

    this.mesh = null
    this.geometry = null
    this.material = null
    this.texture = null
    this.ryskObj = null
    this.isPlaying = false
    this.animationFrameId = null

    this.n = 0
  }

  async mount() {
    this.needsRebuild = false
    if (this.ctx.world.network.isServer) return

    if (!this._videoUrl || !this._dataUrl) return

    const n = ++this.n

    const { URLMesh } = await import('@mantisvision/rysk')
    const { RyskEvents } = await import('@mantisvision/utils')

    if (this.n !== n) return // node was rebuilt or destroyed, stop here

    this.ryskObj = new URLMesh(this._videoUrl, this._dataUrl, 100)
    this.ryskObj.loop = this.loop

    this.ryskObj.on(RyskEvents.dataDecoded, data => {
      this.updateGeometry(data)
    })

    this.ryskObj.on(RyskEvents.error, error => {
      console.error('[volumetric] RYSK error:', error)
    })

    const result = await this.ryskObj.init()

    this.geometry = new THREE.BufferGeometry()

    this.texture = new THREE.VideoTexture(result.video)
    this.texture.flipY = false
    this.texture.minFilter = THREE.LinearFilter
    this.texture.magFilter = THREE.LinearFilter
    this.texture.colorSpace = THREE.SRGBColorSpace

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      side: THREE.FrontSide,
    })

    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.position.set(0, 0, 0)
    this.mesh.rotation.y = Math.PI

    this.mesh.matrixAutoUpdate = false
    this.mesh.matrixWorldAutoUpdate = false
    this.mesh.scale.set(0.0025, 0.0025, 0.0025)
    this.mesh.matrixWorld.copy(this.matrixWorld)
    this.mesh.frustumCulled = false

    this.ctx.world.stage.scene.add(this.mesh)

    // set volume when audio is ready
    this.ctx.world.audio.ready(() => {
      this.ryskObj.setVolume(this.volume)
    })

    this.ctx.world.setHot(this, true)

    await this.ryskObj.play()
    this.isPlaying = true
  }

  update = delta => {
    if (this.ryskObj) {
      this.ryskObj.update()
    }
  }

  updateGeometry(data) {
    if (!this.geometry || !this.mesh) return

    const { uvs, indices, vertices, frameNo } = data

    // skip frames with no real data
    if (!vertices || vertices.length === 0) return
    if (!uvs || uvs.length === 0) return
    if (!indices || indices.length === 0) return

    const vertexCount = vertices.length / 3
    const uvCount = uvs.length / 2
    const indexCount = indices.length

    let maxIndex = 0
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] > maxIndex) maxIndex = indices[i]
    }

    const posAttr = this.geometry.getAttribute('position')
    const uvAttr = this.geometry.getAttribute('uv')
    const indexAttr = this.geometry.getIndex()

    // check if we need to grow buffers (but not shrink - use max capacity)
    const needsResize = !posAttr || posAttr.array.length < vertices.length || !uvAttr || uvAttr.array.length < uvs.length || !indexAttr || indexAttr.array.length < indices.length // prettier-ignore

    if (needsResize) {
      // console.log('RESIZE - vertex count:', vertices.length / 3)

      // allocate with headroom, but ensure sizes stay valid (divisible by 3 for pos, 2 for uv)
      const headroom = 1.5
      const posSize = Math.ceil((vertices.length / 3) * headroom) * 3 // Keep divisible by 3
      const uvSize = Math.ceil((uvs.length / 2) * headroom) * 2 // Keep divisible by 2
      const indexSize = Math.ceil(indices.length * headroom)

      const posArray = new Float32Array(posSize)
      const uvArray = new Float32Array(uvSize)
      const indexArray = new Uint32Array(indexSize)

      // copy current data
      posArray.set(vertices)
      uvArray.set(uvs)
      indexArray.set(indices)

      const posBuffer = new THREE.Float32BufferAttribute(posArray, 3)
      const uvBuffer = new THREE.Float32BufferAttribute(uvArray, 2)
      const indexBuffer = new THREE.Uint32BufferAttribute(indexArray, 1)

      posBuffer.setUsage(THREE.DynamicDrawUsage)
      uvBuffer.setUsage(THREE.DynamicDrawUsage)
      indexBuffer.setUsage(THREE.DynamicDrawUsage)

      this.geometry.setAttribute('position', posBuffer)
      this.geometry.setAttribute('uv', uvBuffer)
      this.geometry.setIndex(indexBuffer)

      // update draw range to only render valid data
      this.geometry.setDrawRange(0, indexCount)
      this.geometry.computeBoundingSphere()
    } else {
      // just update the data in place
      posAttr.array.set(vertices)
      uvAttr.array.set(uvs)
      indexAttr.array.set(indices)

      posAttr.needsUpdate = true
      uvAttr.needsUpdate = true
      indexAttr.needsUpdate = true

      // critical: update draw range if vertex count changed
      this.geometry.setDrawRange(0, indexCount)
    }
  }

  commit() {
    console.log('[volumetric] Node scale:', this.scale.x, this.scale.y, this.scale.z)
    // Sync node transform to mesh
    if (this.mesh) {
      this.mesh.matrixWorld.copy(this.matrixWorld)
    }
  }

  unmount() {
    this.ctx.world.setHot(this, false)

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }

    if (this.ryskObj) {
      this.ryskObj.dispose()
      this.ryskObj = null
    }

    if (this.mesh && this.ctx && this.ctx.world) {
      this.ctx.world.stage.scene.remove(this.mesh)
    }

    if (this.texture) {
      this.texture.dispose()
    }

    if (this.geometry) {
      this.geometry.dispose()
    }

    if (this.material) {
      this.material.dispose()
    }

    this.mesh = null
    this.geometry = null
    this.material = null
    this.texture = null
  }

  get videoUrl() {
    return this._videoUrl
  }

  set videoUrl(value = defaults.videoUrl) {
    if (value && !isString(value)) {
      throw new Error('[volumetric] videoUrl not a string')
    }
    if (this._videoUrl === value) return
    this._videoUrl = value
    this.needsRebuild = true
    this.setDirty()
  }

  get dataUrl() {
    return this._dataUrl
  }

  set dataUrl(value = defaults.dataUrl) {
    if (value && !isString(value)) {
      throw new Error('[volumetric] dataUrl not a string')
    }
    if (this._dataUrl === value) return
    this._dataUrl = value
    this.needsRebuild = true
    this.setDirty()
  }

  get loop() {
    return this._loop
  }

  set loop(value = defaults.loop) {
    if (!isBoolean(value)) {
      throw new Error('[volumetric] loop not a boolean')
    }
    if (this._loop === value) return
    this._loop = value
    this.needsRebuild = true
    this.setDirty()
  }

  get autoplay() {
    return this._autoplay
  }

  set autoplay(value = defaults.autoplay) {
    if (!isBoolean(value)) {
      throw new Error('[volumetric] autoplay not a boolean')
    }
    if (this._autoplay === value) return
    this._autoplay = value
    this.needsRebuild = true
    this.setDirty()
  }

  get volume() {
    return this._volume
  }

  set volume(value = defaults.volume) {
    if (!isNumber(value)) {
      throw new Error('[volumetric] volume not a number')
    }
    if (this._volume === value) return
    this._volume = value
    this.needsRebuild = true
    this.setDirty()
  }

  async play() {
    if (this.ryskObj) {
      try {
        await this.ryskObj.play()
        this.isPlaying = true
        console.log('[volumetric] ▶️ Playing')
      } catch (error) {
        console.error('[volumetric] ❌ Play failed:', error)
      }
    }
  }

  pause() {
    if (this.ryskObj) {
      this.ryskObj.pause()
      this.isPlaying = false
      console.log('[volumetric] ⏸️ Paused')
    }
  }

  setVolume(volume) {
    this.volume = volume
    if (this.ryskObj) {
      this.ryskObj.setVolume(volume)
    }
  }

  getProxy() {
    const self = this
    if (!this.proxy) {
      let proxy = {
        get playing() {
          return self._isPlaying
        },
        play() {
          return self.play()
        },
        pause() {
          self.pause()
        },
        get volume() {
          return self.volume
        },
        set volume(value) {
          self.setVolume(value)
        },
      }
      proxy = Object.defineProperties(proxy, Object.getOwnPropertyDescriptors(super.getProxy()))
      this.proxy = proxy
    }
    return this.proxy
  }
}
