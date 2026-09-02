import { lookup, resolveTxt } from 'node:dns/promises'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import sanitizeHtml from 'sanitize-html'
import { getDomain } from 'tldts'

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
const RESERVED_SUFFIXES = new Set([
  'localhost', 'local', 'internal', 'invalid', 'test', 'example', 'onion',
  'corp', 'home', 'lan', 'intranet', 'private',
])
const MAX_IMAGE_BYTES = 512 * 1024
const SUCCESS_TTL = 60 * 60 * 1000
const FAILURE_TTL = 5 * 60 * 1000
const MAX_CACHE_ENTRIES = 500

export interface BrandIcon {
  body: Uint8Array
  contentType: string
}

export interface BrandIconResolverOptions {
  resolveTxt?: (hostname: string) => Promise<string[][]>
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  now?: () => number
  maxEntries?: number
  successTtl?: number
  failureTtl?: number
}

export function normalizeBrandDomain(value: string): string | null {
  if (!value || value.trim() !== value || value.endsWith('.') || isIP(value)) return null

  const domain = domainToASCII(value).toLowerCase()
  if (!domain || domain.length > 253 || isIP(domain)) return null

  const labels = domain.split('.')
  if (labels.length < 2 || labels.some((label) =>
    label.length === 0 || label.length > 63 ||
    !/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(label),
  )) return null

  const suffix = labels.at(-1)!
  if (!/^(?:[a-z]{2,63}|xn--[a-z\d-]{2,59})$/.test(suffix)) return null
  if (RESERVED_SUFFIXES.has(suffix) || domain === 'home.arpa' || domain.endsWith('.home.arpa')) return null

  return domain
}

export function isPublicBrandAddress(address: string): boolean {
  const family = isIP(address)
  if (!family) return false

  if (family === 6) {
    const normalized = address.toLowerCase().split('%')[0]

    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice(7)
      if (mapped.includes('.')) return isPublicBrandAddress(mapped)

      const parts = mapped.split(':')
      if (parts.length !== 2) return false
      const high = Number.parseInt(parts[0], 16)
      const low = Number.parseInt(parts[1], 16)
      return isPublicBrandAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
    }

    return /^[23][a-f\d]{0,3}:/i.test(normalized) && !/^2001:0?db8:/i.test(normalized)
  }

  const [first, second, third] = address.split('.').map(Number)

  return !(
    first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (third === 0 || third === 2)) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  )
}

export function parseBimiLocation(records: string[][]): string | null {
  for (const record of records) {
    const fields = new Map(
      record.join('').split(';').map((field) => {
        const separator = field.indexOf('=')
        return [field.slice(0, separator).trim().toLowerCase(), field.slice(separator + 1).trim()]
      }),
    )

    if (fields.get('v') !== 'BIMI1') continue

    const location = fields.get('l')
    if (!location) continue

    try {
      const url = new URL(location)
      if (url.protocol === 'https:' && !url.username && !url.password) return url.toString()
    } catch {
      continue
    }
  }

  return null
}

function sanitizeBrandSvg(body: Uint8Array): Uint8Array | null {
  const svg = new TextDecoder('utf-8', { fatal: true }).decode(body)
  const safe = sanitizeHtml(svg, {
    allowedTags: [
      'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
      'defs', 'clipPath', 'clippath', 'linearGradient', 'lineargradient',
      'radialGradient', 'radialgradient', 'stop', 'title', 'desc', 'mask', 'pattern',
    ],
    allowedAttributes: {
      '*': [
        'id', 'class', 'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width',
        'stroke-linecap', 'stroke-linejoin', 'stroke-opacity', 'opacity', 'transform',
        'clip-path', 'clip-rule', 'mask', 'color', 'stop-color', 'stop-opacity',
        'offset', 'gradientUnits', 'gradientTransform', 'spreadMethod',
      ],
      svg: ['xmlns', 'viewBox', 'viewbox', 'width', 'height', 'preserveAspectRatio', 'role'],
      path: ['d'],
      circle: ['cx', 'cy', 'r'],
      ellipse: ['cx', 'cy', 'rx', 'ry'],
      rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
      line: ['x1', 'y1', 'x2', 'y2'],
      polyline: ['points'],
      polygon: ['points'],
      linearGradient: ['x1', 'y1', 'x2', 'y2'],
      radialGradient: ['cx', 'cy', 'r', 'fx', 'fy'],
      pattern: ['x', 'y', 'width', 'height', 'patternUnits', 'patternTransform'],
      mask: ['x', 'y', 'width', 'height', 'maskUnits'],
    },
    allowedSchemes: [],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'style', 'iframe', 'object', 'embed', 'foreignObject'],
    parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
    transformTags: {
      '*': (tagName, attributes) => ({
        tagName,
        attribs: Object.fromEntries(Object.entries(attributes).filter(([, value]) =>
          !/url\s*\(\s*['"]?(?!#)|(?:javascript|data|https?):/i.test(value),
        )),
      }),
    },
  })

  return /^\s*<svg(?:\s|>)/.test(safe) ? new TextEncoder().encode(safe) : null
}

export function createBrandIconResolver(options: BrandIconResolverOptions = {}) {
  const readTxt = options.resolveTxt ?? resolveTxt
  const resolveAddresses = options.lookup ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }))
  const request = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const now = options.now ?? Date.now
  const cache = new Map<string, { icon: BrandIcon | null; expires: number }>()
  const pending = new Map<string, Promise<BrandIcon | null>>()

  async function fetchImage(initial: string, trustedFavicon = false): Promise<BrandIcon | null> {
    let current = new URL(initial)

    for (let redirects = 0; redirects <= 2; redirects += 1) {
      if (current.protocol !== 'https:' || current.username || current.password) return null

      if (trustedFavicon) {
        if (current.hostname !== 'www.google.com' && !/^t\d+\.gstatic\.com$/.test(current.hostname)) {
          return null
        }
      } else {
        if (!normalizeBrandDomain(current.hostname)) return null

        const addresses = await resolveAddresses(current.hostname)
        if (addresses.length === 0 || addresses.some(({ address }) => !isPublicBrandAddress(address))) {
          return null
        }
      }

      const response = await request(current.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(5_000),
        headers: { Accept: 'image/png, image/jpeg, image/webp, image/svg+xml' },
      })

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location || redirects === 2) return null
        current = new URL(location, current)
        continue
      }

      if (!response.ok) return null

      const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      const declaredLength = Number(response.headers.get('content-length'))
      if (!contentType || !IMAGE_TYPES.has(contentType) || declaredLength > MAX_IMAGE_BYTES) return null

      const reader = response.body?.getReader()
      if (!reader) return null

      const chunks: Uint8Array[] = []
      let size = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength

        if (size > MAX_IMAGE_BYTES) {
          await reader.cancel()
          return null
        }

        chunks.push(value)
      }

      if (size === 0) return null

      const body = new Uint8Array(size)
      let offset = 0

      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }

      if (contentType === 'image/svg+xml') {
        const sanitized = sanitizeBrandSvg(body)
        return sanitized ? { body: sanitized, contentType } : null
      }

      return { body, contentType }
    }

    return null
  }

  async function resolve(domain: string): Promise<BrandIcon | null> {
    const root = getDomain(domain, { allowPrivateDomains: true })
    const domains = root && root !== domain ? [domain, root] : [domain]
    for (const candidate of domains) {
      const location = await readTxt(`default._bimi.${candidate}`)
        .then(parseBimiLocation)
        .catch(() => null)

      if (location) {
        const icon = await fetchImage(location).catch(() => null)
        if (icon) return icon
      }
    }

    for (const candidate of [...domains].reverse()) {
      const icon = await fetchImage(
        `https://www.google.com/s2/favicons?domain=${encodeURIComponent(candidate)}&sz=128`,
        true,
      ).catch(() => null)
      if (icon) return icon
    }
    return null
  }

  return async (userId: string, value: string): Promise<BrandIcon | null> => {
    const domain = normalizeBrandDomain(value)
    if (!userId || !domain) return null

    const key = `${userId}\0${domain}`
    const cached = cache.get(key)

    if (cached && cached.expires > now()) return cached.icon
    if (cached) cache.delete(key)

    const current = pending.get(key)
    if (current) return current

    const operation = resolve(domain).then((icon) => {
      while (cache.size >= (options.maxEntries ?? MAX_CACHE_ENTRIES)) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }

      cache.set(key, {
        icon,
        expires: now() + (icon ? options.successTtl ?? SUCCESS_TTL : options.failureTtl ?? FAILURE_TTL),
      })
      return icon
    }).finally(() => pending.delete(key))

    pending.set(key, operation)
    return operation
  }
}
