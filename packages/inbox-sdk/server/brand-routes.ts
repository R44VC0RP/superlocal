import { Hono } from 'hono'
import { auth } from './auth'
import { createBrandIconResolver, normalizeBrandDomain, type BrandIcon } from './brand-icons'

interface BrandRouterOptions {
  getSession?: (headers: Headers) => Promise<{ user: { id: string } } | null>
  resolveIcon?: (userId: string, domain: string) => Promise<BrandIcon | null>
}

export function createBrandRouter(options: BrandRouterOptions = {}) {
  const router = new Hono<{ Variables: { userId: string } }>()
  const getSession = options.getSession ?? ((headers: Headers) => auth.api.getSession({ headers }))
  const resolveIcon = options.resolveIcon ?? createBrandIconResolver()

  router.use('*', async (c, next) => {
    const session = await getSession(c.req.raw.headers).catch(() => null)
    if (!session?.user?.id) return c.json({ error: 'Unauthorized' }, 401)
    c.set('userId', session.user.id)
    await next()
  })

  router.get('/:domain/icon', async (c) => {
    const domain = normalizeBrandDomain(c.req.param('domain'))
    if (!domain) return c.json({ error: 'Invalid sender domain' }, 400)

    const icon = await resolveIcon(c.get('userId'), domain)
    if (!icon) return new Response(null, {
      status: 204,
      headers: {
        'Cache-Control': 'private, max-age=300',
        Vary: 'Cookie',
      },
    })

    return new Response(new Uint8Array(icon.body), {
      headers: {
        'Content-Type': icon.contentType,
        'Cache-Control': 'private, max-age=3600',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        Vary: 'Cookie',
      },
    })
  })

  return router
}

export const brandRouter = createBrandRouter()
