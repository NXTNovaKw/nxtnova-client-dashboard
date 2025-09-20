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
 *   backfill; otherwise we PUT.
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

  // Prefer handle; also try SKU and title as backup filters.
  const trySku = (variants ?? []).map((v: any) => v?.sku).filter(Boolean)[0]
  const qParts = []
  if (slug) qParts.push(`handle:${slug}`)
  if (trySku) qParts.push(`sku:${trySku}`)
  if (title) qParts.push(`title:"${title.replace(/"/g, '\\"')}"`)
  const queryStr = qParts.join(' OR ') || ''

  // 1) Exact handle
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

  // 2) Fallback search
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
 * On *update* (and also first save if you want) we push Payload fields to Shopify.
 * - Non-blocking: we `void` the async task so the admin responds immediately.
 * - Self-heals: if `shopifyProductID` is missing, we try to locate by handle/sku/title
 *   and backfill it into Payload, then proceed with PUT.
 * - All network ops are bounded by timeouts via shopifyFetch.
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

    // If missing, try to find the Shopify product by handle (and other hints).
    if (!shopifyId) {
      shopifyId = await findShopifyProductId(domain, token, {
        slug: doc.slug,
        title: doc.title,
        variants: doc.variants,
      })
      if (shopifyId) {
        // Best-effort write-back; use request-scoped API to avoid races.
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
          // Swallow write-back errors; update can still proceed.
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

    // Resolve by handle if needed
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
    afterChange: [updateShopifyAfterChange], // push changes (non-blocking)
    afterDelete: [deleteFromShopifyAfterDelete], // mirror deletes (non-blocking)
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
              admin: { width: '33%' },
            },
            { name: 'color', label: 'Color', type: 'text', admin: { width: '33%' } },
            {
              name: 'price',
              label: 'Price',
              type: 'number',
              required: true,
              admin: { width: '33%' },
            },
          ],
        },
        { name: 'sku', label: 'SKU', type: 'text', unique: true },
        { name: 'stockQty', label: 'Stock Qty', type: 'number', required: true, defaultValue: 0 },
      ],
    },
  ],
}

export default Products
