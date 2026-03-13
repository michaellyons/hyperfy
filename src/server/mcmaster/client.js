/**
 * McMaster-Carr Product Information API Client
 * Ported from TypeScript — plain ES module.
 */

export class McMasterClient {
  constructor({ certPath, certPassword, username, password, baseUrl } = {}) {
    this.certPath     = certPath
    this.certPassword = certPassword
    this.username     = username
    this.password     = password
    this.baseUrl      = baseUrl ?? 'https://api.mcmaster.com/v1'
    this._token       = null
    this._expiration  = null
  }

  isAuthenticated() {
    return !!this._token && (!this._expiration || new Date() < this._expiration)
  }

  async login() {
    const res = await this._fetch('/login', {
      method: 'POST',
      body:   JSON.stringify({ UserName: this.username, Password: this.password }),
    })
    const data     = await res.json()
    this._token      = data.Token
    this._expiration = new Date(data.Expiration)
    return data
  }

  async logout() {
    if (!this._token) return
    await this._fetchAuth('/logout', { method: 'POST', body: JSON.stringify({ Token: this._token }) })
    this._token = null; this._expiration = null
  }

  async getProductData(partNumber) {
    this._assertAuth()
    const res = await this._fetchAuth('/productdata', {
      method: 'POST',
      body:   JSON.stringify({ PartNumber: partNumber }),
    })
    return res.json()
  }

  async getCADFile(partNumber, fileType = 'STEP') {
    this._assertAuth()
    const params = new URLSearchParams({ PartNumber: partNumber, FileType: fileType })
    const res    = await this._fetchAuth(`/cadfile?${params}`, { method: 'GET' })
    return res.blob()
  }

  async getProductImageUrl(partNumber, options = {}) {
    this._assertAuth()
    const params = new URLSearchParams({ PartNumber: partNumber })
    if (options.imageId)   params.append('ImageID',    options.imageId)
    if (options.resolution) params.append('Resolution', options.resolution)
    const res = await this._fetchAuth(`/productimage?${params}`, { method: 'GET' })
    return res.url  // redirect URL
  }

  _assertAuth() {
    if (!this.isAuthenticated()) throw new Error('McMasterClient: call login() first')
  }

  async _fetch(endpoint, options) {
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ ErrorMessage: res.statusText }))
      throw new Error(err.ErrorMessage ?? `HTTP ${res.status}`)
    }
    return res
  }

  async _fetchAuth(endpoint, options) {
    return this._fetch(endpoint, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${this._token}` },
    })
  }
}
