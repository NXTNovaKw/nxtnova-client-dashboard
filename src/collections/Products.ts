/**
 * Products Collection for nxtNove Dashboard
 *
 * Purpose
 * -------
 * - Define the 'products' collection schema for Payload.
 * - Keep Shopify and Payload synchronized (Create, Update, Delete).
 *
 * Design
 * ------
 * - CREATE: Happens in `beforeChange` so we can write the Shopify ID
 *   directly into the same Payload insert (atomic). Bound by timeout and
 *   "fail open" (we never block the admin UI).
 * - UPDATE: Happens in `afterChange` and is fire-and-forget (we don't await).
 *   If the Shopify ID is missing, we attempt to find it by handle and
 *   backfill; otherwise we PUT. After a successful PUT, we ensure images exist,
 *   then sync inventory levels per-variant.
 * - DELETE: Happens in `afterDelete` and is fire-and-forget; we delete by ID,
 *   or resolve by handle if needed. 404 is treated as success.
 *
 * Notes
 * -----
 * - Uses request-scoped `req.payload` when writing back to avoid race issues.
 * - All Shopify calls have a hard timeout via AbortController to avoid UI hangs.
 */

import type { CollectionConfig } from 'payload'

// -------------------------------------------------------------------
// Strongly-Typed Hook Signatures (version-agnostic)
// -------------------------------------------------------------------
type BeforeChange = NonNullable<NonNullable<CollectionConfig['hooks']>['beforeChange']>[number]
type AfterChange = NonNullable<NonNullable<CollectionConfig['hooks']>['afterChange']>[number]
type AfterDelete = NonNullable<NonNullable<CollectionConfig['hooks']>['afterDelete']>[number]

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

/**
 * shopifyFetch
 * ------------
 * Wrapper around fetch with a hard timeout (12s) so admin UI never hangs.
 * Returns `undefined` on timeout/network errors; callers should "fail open".
 */
const SHOPIFY_TIMEOUT_MS = 12_000
const shopifyFetch = async (url: string, init: RequestInit, logger: any) => {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS) })
    return res
  } catch (e) {
    logger.error(`[Shopify] request failed (timeout ${SHOPIFY_TIMEOUT_MS}ms): ${String(e)}`)
    return undefined
  }
}

/**
 * coerceShopifyId
 * ---------------
 * Shopify returns IDs as numbers or GIDs (e.g., "gid://shopify/Product/12345").
 * This helper extracts a numeric string ("12345") in all cases.
 */
const coerceShopifyId = (id: unknown): string => {
  if (id == null) return ''
  const s = String(id)
  const tail = s.includes('/') ? s.split('/').pop() : s
  return (tail || '').replace(/\D/g, '') || ''
}

/**
 * absoluteMediaURL
 * ----------------
 * Build an absolute URL for a media path or URL. Works for:
 *  - absolute URLs (returned as-is)
 *  - '/api/media/...'
 *  - '/media/...'
 * Prefers env bases (ngrok/prod), falls back to request host.
 */
const absoluteMediaURL = (req: any, path?: string) => {
  if (!path) return ''
  if (/^https?:\/\//i.test(path)) return path

  const baseCandidates = [
    process.env.NEXT_PUBLIC_PAYLOAD_API_URL, // can include '/api'
    process.env.PAYLOAD_PUBLIC_SERVER_URL, // root without '/api'
  ].filter(Boolean) as string[]

  if (baseCandidates.length === 0) {
    const proto = (req.headers?.['x-forwarded-proto'] as string) || 'http'
    const host = (req.headers?.host as string) || 'localhost'
    baseCandidates.push(`${proto}://${host}`)
  }

  try {
    return new URL(path, baseCandidates[0]).toString()
  } catch {
    const base = baseCandidates[0]!.replace(/\/$/, '')
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    return `${base}${cleanPath}`
  }
}

/**
 * collectProductImages
 * --------------------
 * Normalize product images to an array of `{ url, alt, filename }`.
 * If the `image` is an ID, fetch the media doc to read `url`.
 */
const collectProductImages = async (req: any, doc: any) => {
  const out: Array<{ url: string; alt?: string; filename?: string }> = []
  const items = Array.isArray(doc?.productImages) ? doc.productImages : []
  for (const item of items) {
    let img = item?.image
    if (!img) continue
    if (typeof img === 'string' || typeof img === 'number') {
      try {
        img = await req.payload.findByID({
          collection: 'media',
          id: String(img),
          depth: 0,
          overrideAccess: true,
        })
      } catch {
        /* ignore and continue */
      }
    }
    const url = absoluteMediaURL(req, img?.url)
    if (!url) continue
    out.push({ url, alt: img?.alt || doc?.title, filename: img?.filename })
  }
  return out
}

/** Normalize a filename-like string (lowercase, trim). */
const normName = (s?: string) => (s || '').toString().trim().toLowerCase()

/** Best-effort filename from a URL. */
const filenameFromUrl = (u?: string) => {
  if (!u) return ''
  try {
    const p = new URL(u).pathname
    const last = p.split('/').pop() || ''
    return last.split('?')[0] // strip query
  } catch {
    // not a full URL, treat as path
    const last = u.split('/').pop() || ''
    return last.split('?')[0]
  }
}

/**
 * syncShopifyImages
 * -----------------
 * Ensure Shopify has images for the product, deduping by filename:
 *  - We fetch existing images and build a set of names (alt || basename(src)).
 *  - For each Payload media, we compute a name (filename || basename(url)).
 *  - If name exists, skip; otherwise upload (src when public, base64 fallback).
 */
const syncShopifyImages = async (
  req: any,
  shopifyId: string,
  doc: any,
  domain: string,
  token: string,
) => {
  const base = `https://${domain}/admin/api/2024-04`
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }

  // Collect candidate images from Payload
  const candidates = await collectProductImages(req, doc)
  if (!candidates.length) return

  // Read existing Shopify images once
  const existingRes = await shopifyFetch(
    `${base}/products/${shopifyId}/images.json`,
    { headers },
    req.payload.logger,
  )
  const existingJson = existingRes ? await existingRes.json().catch(() => ({}) as any) : {}
  const existingImgs: any[] = Array.isArray(existingJson?.images) ? existingJson.images : []

  // Build a set of normalized names already in Shopify
  const existingNames = new Set<string>()
  for (const ex of existingImgs) {
    const exName = normName(ex?.alt) || normName(filenameFromUrl(ex?.src))
    if (exName) existingNames.add(exName)
  }

  // Upload only images that are not already there by "name" (filename)
  for (const img of candidates) {
    const fname = normName(img.filename || filenameFromUrl(img.url))
    if (!fname) {
      req.payload.logger.warn('[Shopify] image skipped (no detectable filename)')
      continue
    }
    if (existingNames.has(fname)) {
      req.payload.logger.info(`[Shopify] skip image "${fname}" (already exists)`)
      continue
    }

    const isPublic = /^https?:\/\//i.test(img.url) && !/localhost|127\.0\.0\.1/i.test(img.url)
    let body: any

    if (isPublic) {
      // Use filename as alt so subsequent runs can dedupe by name
      body = { image: { src: img.url, alt: img.filename || filenameFromUrl(img.url) } }
    } else {
      try {
        const fileRes = await fetch(img.url)
        const buff = Buffer.from(await fileRes.arrayBuffer()).toString('base64')
        body = {
          image: {
            attachment: buff,
            filename: img.filename || 'image.jpg',
            alt: img.filename || 'image.jpg',
          },
        }
      } catch (e) {
        req.payload.logger.warn(
          `[Shopify] could not read ${img.url} for base64 upload: ${String(e)}`,
        )
        continue
      }
    }

    const res = await shopifyFetch(
      `${base}/products/${shopifyId}/images.json`,
      { method: 'POST', headers, body: JSON.stringify(body) },
      req.payload.logger,
    )
    if (!res) continue

    if (!res.ok) {
      const t = await res.text()
      req.payload.logger.error(`[Shopify] image upload failed for "${fname}": ${t}`)
    } else {
      req.payload.logger.info(`[Shopify] image added "${fname}"`)
      existingNames.add(fname) // prevent double-upload within same run
    }
  }
}

/**
 * findShopifyProductId
 * --------------------
 * Attempts to locate a Shopify product ID by:
 *  1) handle (exact match), then
 *  2) fallback product search (by handle/sku/title).
 * Returns a numeric string ID or '' if not found.
 */
const findShopifyProductId = async (
  domain: string,
  token: string,
  { slug, title, variants }: { slug?: string; title?: string; variants?: any[] },
): Promise<string | ''> => {
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }
  const base = `https://${domain}/admin/api/2024-04`

  const trySku = (variants ?? []).map((v: any) => v?.sku).filter(Boolean)[0]
  const qParts = []
  if (slug) qParts.push(`handle:${slug}`)
  if (trySku) qParts.push(`sku:${trySku}`)
  if (title) qParts.push(`title:"${title.replace(/"/g, '\\"')}"`)
  const queryStr = qParts.join(' OR ') || ''

  if (slug) {
    const res = await fetch(`${base}/graphql.json`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: `query($h:String!){ productByHandle(handle:$h){ id } }`,
        variables: { h: slug },
      }),
    })
    const j = await res.json()
    const gid = j?.data?.productByHandle?.id
    if (gid) return coerceShopifyId(gid)
  }

  if (queryStr) {
    const res = await fetch(`${base}/graphql.json`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query: `query($q:String!){ products(first:5, query:$q){ edges { node { id handle title } } } }`,
        variables: { q: queryStr },
      }),
    })
    const j = await res.json()
    const edges = j?.data?.products?.edges ?? []
    const first = edges[0]?.node?.id
    if (first) return coerceShopifyId(first)
  }

  return ''
}

// ---------- INVENTORY HELPERS (NEW) ---------------------------------

/** Pick a location id: env wins; else first active location. */
const getLocationId = async (domain: string, token: string, logger: any): Promise<string> => {
  if (process.env.SHOPIFY_LOCATION_ID) return process.env.SHOPIFY_LOCATION_ID
  const res = await fetch(`https://${domain}/admin/api/2024-04/locations.json`, {
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  })
  const j = await res.json()
  const firstActive = (j?.locations || []).find((l: any) => l?.active)
  if (!firstActive?.id) {
    logger.warn('[Shopify] no active location found; cannot set inventory levels')
    return ''
  }
  logger.info(`[Shopify] using fallback location ${firstActive.id}`)
  return String(firstActive.id)
}
const tinyDelay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * syncShopifyInventory
 * --------------------
 * Sets inventory for each variant at a location.
 * - Prefers matching by SKU; falls back to index.
 * - Skips variants where trackQuantity === false.
 */
const syncShopifyInventory = async (
  req: any,
  shopifyId: string,
  doc: any,
  domain: string,
  token: string,
) => {
  const { payload } = req
  const base = `https://${domain}/admin/api/2024-04`
  const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }

  const locationId = await getLocationId(domain, token, payload.logger)
  if (!locationId) {
    payload.logger.warn('[Shopify] skipping inventory sync (no location id).')
    return
  }

  try {
    const res = await shopifyFetch(
      `${base}/products/${shopifyId}.json`,
      { headers },
      payload.logger,
    )
    if (!res) return
    const json = await res.json()
    const shopifyVariants: any[] = json?.product?.variants ?? []

    const bySku = new Map<string, any>()
    for (const v of shopifyVariants) if (v?.sku) bySku.set(String(v.sku), v)

    const locals: any[] = Array.isArray(doc?.variants) ? doc.variants : []

    for (let i = 0; i < locals.length; i++) {
      const local = locals[i]
      if (local?.trackQuantity === false) continue

      const sv = (local?.sku && bySku.get(String(local.sku))) || shopifyVariants[i] || null

      const invItemId = sv?.inventory_item_id
      if (!invItemId) {
        payload.logger.warn(
          `[Shopify] no inventory_item_id for variant ${i} (sku=${local?.sku ?? '∅'})`,
        )
        continue
      }

      const body = {
        location_id: Number(locationId),
        inventory_item_id: Number(invItemId),
        available: Number(local?.stockQty ?? 0),
      }

      const setRes = await shopifyFetch(
        `${base}/inventory_levels/set.json`,
        { method: 'POST', headers, body: JSON.stringify(body) },
        payload.logger,
      )
      if (!setRes) continue

      if (setRes.status === 429) {
        await tinyDelay(400)
        const retry = await shopifyFetch(
          `${base}/inventory_levels/set.json`,
          { method: 'POST', headers, body: JSON.stringify(body) },
          payload.logger,
        )
        if (!retry || !retry.ok) {
          const t = retry ? await retry.text() : '(timeout)'
          payload.logger.error(`[Shopify] inventory set retry failed: ${t}`)
        }
        continue
      }

      if (!setRes.ok) {
        const t = await setRes.text()
        payload.logger.error(`[Shopify] inventory set failed: ${t}`)
      } else {
        payload.logger.info(
          `[Shopify] inventory set: inv_item=${invItemId} loc=${locationId} qty=${body.available}`,
        )
      }
    }

    payload.logger.info(`[Shopify] inventory sync complete for product ${shopifyId}`)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    payload.logger.error(`[Shopify] Inventory sync error for product ${shopifyId}: ${msg}`)
  }
}

// -------------------------------------------------------------------
// Hooks
// -------------------------------------------------------------------

/**
 * formatSlug (beforeChange)
 * -------------------------
 * Generates a URL-safe slug from Title and ensures uniqueness.
 * - Runs on both create and update.
 * - Never touches `shopifyProductID` (so edits won’t lose linkage).
 */
const formatSlug: BeforeChange = async ({ data, req }) => {
  if (!data?.title) return data

  const base = data.title
    .toLowerCase()
    .replace(/ /g, '-')
    .replace(/[^\w-]+/g, '')
  let unique = base,
    i = 2

  while (true) {
    const { docs } = await req.payload.find({
      collection: 'products',
      where: {
        slug: { equals: unique },
        ...(data?.id ? { id: { not_equals: data.id } } : {}), // avoid matching self on edit
      },
      limit: 1,
    })
    if (docs.length === 0) break
    unique = `${base}-${i++}`
  }

  return { ...data, slug: unique }
}

/**
 * createOnShopifyBeforeChange (beforeChange)
 * ------------------------------------------
 * On *create* only:
 *  - Creates the product in Shopify first (POST).
 *  - Writes the new Shopify ID into the same Payload insert (atomic).
 *  - Bound by timeout and fails open (never blocks the admin).
 */
const createOnShopifyBeforeChange: BeforeChange = async ({ data, req, operation }) => {
  if (operation !== 'create' || data?.shopifyProductID) return data // no-op if already linked

  const { payload } = req
  const domain = process.env.SHOPIFY_STORE_DOMAIN
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
  if (!domain || !token) return data // not configured → skip silently

  const hasVariants = Array.isArray(data?.variants) && data.variants.length > 0
  const options: any[] = []
  if (hasVariants) {
    if (data.variants.some((v: any) => v?.size)) options.push({ name: 'Size' })
    if (data.variants.some((v: any) => v?.color)) options.push({ name: 'Color' })
  }

  const body = {
    product: {
      title: data?.title,
      handle: data?.slug,
      status: data?.status === 'active' ? 'active' : 'draft',
      ...(options.length ? { options } : {}),
      variants: (data?.variants ?? []).map((v: any) => ({
        price: v.price,
        sku: v.sku,
        option1: v.size || undefined,
        option2: v.color || undefined,
        // inventory flags on create
        inventory_management: v?.trackQuantity === false ? null : 'shopify',
        inventory_policy: 'deny', // change to 'continue' if you allow overselling
      })),
    },
  }

  try {
    const res = await shopifyFetch(
      `https://${domain}/admin/api/2024-04/products.json`,
      {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      payload.logger,
    )
    if (!res) return data // network/timeout → don't block

    const json = await res.json()
    if (!res.ok || !json?.product?.id) {
      throw new Error(`Shopify create failed: ${JSON.stringify(json?.errors ?? json)}`)
    }

    const shopifyId = coerceShopifyId(json.product.id)
    payload.logger.info(`[Shopify] Created product id=${shopifyId}`)
    return { ...data, shopifyProductID: shopifyId } // atomic write-back
  } catch (e: unknown) {
    payload.logger.error(`[Shopify] Create error: ${e instanceof Error ? e.message : String(e)}`)
    return data // fail-open
  }
}

/**
 * updateShopifyAfterChange (afterChange)
 * --------------------------------------
 * On *update* (and also first save) we push Payload fields to Shopify.
 * - Non-blocking.
 * - Self-heals missing `shopifyProductID`.
 * - After successful PUT, ensures images exist and syncs inventory.
 */
const updateShopifyAfterChange: AfterChange = ({ doc, req, operation }) => {
  if (req.context?.skipShopifySync) return
  if (operation !== 'update' && operation !== 'create') return

  const domain = process.env.SHOPIFY_STORE_DOMAIN
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
  if (!domain || !token) return

  void (async () => {
    const base = `https://${domain}/admin/api/2024-04`
    let shopifyId = doc.shopifyProductID ? String(doc.shopifyProductID) : ''

    if (!shopifyId) {
      shopifyId = await findShopifyProductId(domain, token, {
        slug: doc.slug,
        title: doc.title,
        variants: doc.variants,
      })
      if (shopifyId) {
        try {
          await req.payload.update({
            collection: 'products',
            id: String(doc.id),
            data: { shopifyProductID: shopifyId },
            overrideAccess: true,
            depth: 0,
            context: { skipShopifySync: true },
          })
          req.payload.logger.info(`[Shopify] backfilled product id=${shopifyId}`)
        } catch {
          /* ignore */
        }
      }
    }

    if (!shopifyId) {
      req.payload.logger.warn(
        '[Shopify] update skipped (no shopifyProductID and not found by handle)',
      )
      return
    }

    const hasVariants = Array.isArray(doc?.variants) && doc.variants.length > 0
    const options: any[] = []
    if (hasVariants) {
      if (doc.variants.some((v: any) => v?.size)) options.push({ name: 'Size' })
      if (doc.variants.some((v: any) => v?.color)) options.push({ name: 'Color' })
    }

    const body = {
      product: {
        id: shopifyId,
        title: doc.title,
        handle: doc.slug,
        status: doc.status === 'active' ? 'active' : 'draft',
        ...(options.length ? { options } : {}),
        variants: (doc?.variants ?? []).map((v: any) => ({
          price: v.price,
          sku: v.sku,
          option1: v.size || undefined,
          option2: v.color || undefined,
          // inventory flags on update
          inventory_management: v?.trackQuantity === false ? null : 'shopify',
          inventory_policy: 'deny',
        })),
      },
    }

    const res = await shopifyFetch(
      `${base}/products/${shopifyId}.json`,
      {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      req.payload.logger,
    )
    if (!res) return // timeout already logged

    if (!res.ok) {
      const t = await res.text()
      req.payload.logger.error(`[Shopify] PUT failed: ${t}`)
      return
    }
    req.payload.logger.info(`[Shopify] updated product id=${shopifyId}`)

    // Ensure images exist on Shopify (uses your ngrok public URL or base64 as fallback)
    await syncShopifyImages(req, shopifyId, doc, domain, token)
    // ✅ Sync inventory levels per variant to a location
    await syncShopifyInventory(req, shopifyId, doc, domain, token)
  })()
}

/**
 * deleteFromShopifyAfterDelete (afterDelete)
 * ------------------------------------------
 * Mirrors deletions: when a product is removed from Payload we remove it in Shopify.
 * - Non-blocking; uses timeout wrapper.
 * - Deletes by known ID; otherwise resolves by handle (GraphQL).
 * - Treats 404 as success (already gone).
 */
const deleteFromShopifyAfterDelete: AfterDelete = ({ req, doc }) => {
  const domain = process.env.SHOPIFY_STORE_DOMAIN
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
  if (!domain || !token) return

  void (async () => {
    const base = `https://${domain}/admin/api/2024-04`
    const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' }

    let shopifyId = doc?.shopifyProductID ? String(doc.shopifyProductID) : ''

    if (!shopifyId && doc?.slug) {
      const lookup = await shopifyFetch(
        `${base}/graphql.json`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            query: `query($h:String!){ productByHandle(handle:$h){ id } }`,
            variables: { h: doc.slug },
          }),
        },
        req.payload.logger,
      )
      const j = await lookup?.json()
      const gid = j?.data?.productByHandle?.id
      if (gid) shopifyId = coerceShopifyId(gid)
    }

    if (!shopifyId) {
      req.payload.logger.warn(
        `[Shopify] delete: no shopifyProductID and not found by handle for slug=${doc?.slug}`,
      )
      return
    }

    const res = await shopifyFetch(
      `${base}/products/${shopifyId}.json`,
      { method: 'DELETE', headers },
      req.payload.logger,
    )
    if (!res) return
    if (res.status === 404) {
      req.payload.logger.info(`[Shopify] delete: product ${shopifyId} already gone (404).`)
      return
    }
    if (!res.ok) {
      const t = await res.text()
      req.payload.logger.error(`[Shopify] delete failed: ${t}`)
      return
    }
    req.payload.logger.info(`[Shopify] deleted product ${shopifyId} to match Payload delete.`)
  })()
}

// -------------------------------------------------------------------
// Collection Definition
// -------------------------------------------------------------------
const Products: CollectionConfig = {
  slug: 'products',
  admin: { useAsTitle: 'title' },

  hooks: {
    beforeChange: [formatSlug, createOnShopifyBeforeChange], // slug + atomic Shopify create
    afterChange: [updateShopifyAfterChange], // push changes + ensure images + inventory
    afterDelete: [deleteFromShopifyAfterDelete], // mirror deletes
  },

  access: {
    // Admins see everything; public queries only see active products.
    read: ({ req }) => (req.user ? true : { status: { equals: 'active' } }),
  },

  // Minimal product model required for MVP; extend as the catalog grows.
  fields: [
    { name: 'title', label: 'Product Title', type: 'text', required: true },

    {
      name: 'status',
      label: 'Status',
      type: 'select',
      options: [
        { label: 'Draft', value: 'draft' },
        { label: 'Active', value: 'active' },
      ],
      defaultValue: 'draft',
      required: true,
      admin: { position: 'sidebar' },
    },

    {
      name: 'slug',
      label: 'Slug',
      type: 'text',
      required: true,
      unique: true,
      admin: { position: 'sidebar', readOnly: true }, // auto-managed by hook
    },

    {
      name: 'shopifyProductID',
      label: 'Shopify Product ID',
      type: 'text',
      admin: { readOnly: true, position: 'sidebar' }, // system-managed
    },

    { name: 'description', label: 'Product Description', type: 'richText' },

    {
      name: 'productImages',
      label: 'Product Images',
      type: 'array',
      minRows: 1,
      fields: [{ name: 'image', type: 'upload', relationTo: 'media', required: true }],
    },

    {
      name: 'category',
      label: 'Category',
      type: 'relationship',
      relationTo: 'categories',
      required: true,
    },

    {
      name: 'variants',
      label: 'Product Variants',
      type: 'array',
      required: true,
      minRows: 1,
      fields: [
        {
          type: 'row',
          fields: [
            {
              name: 'size',
              label: 'Size',
              type: 'select',
              options: ['S', 'M', 'L', 'XL', 'XXL'],
              admin: { width: '25%' },
            },
            { name: 'color', label: 'Color', type: 'text', admin: { width: '25%' } },
            { name: 'sku', label: 'SKU', type: 'text', unique: true, admin: { width: '25%' } },
            {
              name: 'price',
              label: 'Price',
              type: 'number',
              required: true,
              admin: { width: '25%' },
            },
          ],
        },
        {
          type: 'row',
          fields: [
            {
              name: 'stockQty',
              label: 'Stock Qty',
              type: 'number',
              required: true,
              defaultValue: 0,
              admin: { width: '33%' },
            },
            {
              name: 'trackQuantity',
              label: 'Track quantity',
              type: 'checkbox',
              defaultValue: true,
              admin: { width: '33%' },
            },
          ],
        },
      ],
    },
  ],
}

export default Products
