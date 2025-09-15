// src/collections/Products.ts
import type { CollectionConfig } from 'payload'

// ---- derive hook types (no `/types` imports)
type BeforeChange = NonNullable<NonNullable<CollectionConfig['hooks']>['beforeChange']>[number]
type AfterChange  = NonNullable<NonNullable<CollectionConfig['hooks']>['afterChange']>[number]

// -------- helpers
const toCommaList = (arr?: string[]) => Array.isArray(arr) ? arr.filter(Boolean).join(', ') : undefined

const richTextToPlain = (rt: any): string => {
  try {
    if (typeof rt === 'string') return rt
    if (Array.isArray(rt)) return rt.map((n: any) => n?.children?.map((c: any)=>c?.text).join('') ?? '').join('\n\n')
    return ''
  } catch { return '' }
}

// --- HOOK 1: unique slug
const formatSlug: BeforeChange = async ({ data, req }) => {
  if (!data?.title) return data
  const base = data.title.toLowerCase().replace(/ /g, '-').replace(/[^\w-]+/g, '')
  let unique = base, i = 1
  while (true) {
    const { docs } = await req.payload.find({
      collection: 'products',
      where: { slug: { equals: unique }, ...(data?.id ? { id: { not_equals: data.id } } : {}) },
      limit: 1,
    })
    if (docs.length === 0) break
    unique = `${base}-${i++}`
  }
  return { ...data, slug: unique }
}

// --- HOOK 2: sync with Shopify (create / update, images, inventory, collections)
const syncToShopify: AfterChange = async ({ doc, req, operation }) => {
  if (operation !== 'create' && operation !== 'update') return

  const domain = process.env.SHOPIFY_STORE_DOMAIN
  const token  = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN
  const locationId = process.env.SHOPIFY_LOCATION_ID // optional for inventory

  if (!domain || !token) {
    req.payload.logger.warn('Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN; skipping Shopify sync.')
    return
  }

  const base = `https://${domain}/admin/api/2024-04`
  const body_html = richTextToPlain(doc.description)

  const hasVariants = Array.isArray(doc.variants) && doc.variants.length > 0
  const options: any[] = []
  if (hasVariants) {
    if (doc.variants.some((v: any)=> v?.size))  options.push({ name: 'Size' })
    if (doc.variants.some((v: any)=> v?.color)) options.push({ name: 'Color' })
  }

  const productPayload: any = {
    product: {
      title: doc.title,
      handle: doc.slug,
      status: doc.shopify?.status ?? 'active', // 'active' | 'draft' | 'archived'
      body_html,
      vendor: doc.shopify?.vendor || undefined,
      product_type: doc.shopify?.productType || undefined,
      tags: toCommaList(doc.shopify?.tags),
      metafields_global_title_tag: doc.seo?.title || undefined,
      metafields_global_description_tag: doc.seo?.description || undefined,
      ...(options.length ? { options } : {}),
      ...(hasVariants ? {
        variants: doc.variants.map((v: any) => ({
          price:               v.price != null ? String(v.price) : undefined,
          compare_at_price:    v.compareAtPrice != null ? String(v.compareAtPrice) : undefined,
          sku:                 v.sku || undefined,
          barcode:             v.barcode || undefined,
          taxable:             v.taxable ?? true,
          requires_shipping:   v.requiresShipping ?? true,
          weight:              v.weight ?? undefined,
          weight_unit:         v.weightUnit || undefined, // 'g' | 'kg' | 'oz' | 'lb'
          option1:             v.size || undefined,
          option2:             v.color || undefined,
          inventory_policy:    v.continueSelling ? 'continue' : 'deny',
          inventory_management: v.trackQuantity ? 'shopify' : null,
        })),
      } : undefined),
    },
  }

  try {
    let productId = doc.shopifyProductID as string | undefined
    if (!productId) {
      const res = await fetch(`${base}/products.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(productPayload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(`Create failed: ${JSON.stringify(data?.errors ?? data)}`)
      productId = String(data?.product?.id)
      await req.payload.update({
        collection: 'products',
        id: doc.id,
        data: { shopifyProductID: productId },
        overrideAccess: true,
        depth: 0,
      })
      req.payload.logger.info(`✅ Shopify create: ${productId}`)
    } else {
      const res = await fetch(`${base}/products/${productId}.json`, {
        method: 'PUT',
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(productPayload),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(`Update failed: ${JSON.stringify(data?.errors ?? data)}`)
      req.payload.logger.info(`🔄 Shopify update: ${productId}`)
    }

    // Images
    if (doc.productImages?.length && productId) {
      for (const item of doc.productImages) {
        const img = item?.image
        const src = typeof img === 'object' ? img?.url : undefined
        if (!src) continue
        await fetch(`${base}/products/${productId}/images.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: { src, alt: img?.alt || doc.title } }),
        })
      }
    }

    // Collections
    if (Array.isArray(doc.shopify?.collectionIds) && doc.shopify.collectionIds.length && productId) {
      for (const cid of doc.shopify.collectionIds) {
        await fetch(`${base}/collects.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ collect: { product_id: productId, collection_id: cid } }),
        })
      }
    }

    // Inventory (optional)
    if (locationId && productId && Array.isArray(doc.variants) && doc.variants.length) {
      const res = await fetch(`${base}/products/${productId}.json`, {
        headers: { 'X-Shopify-Access-Token': token },
      })
      const data = await res.json()
      const variants: any[] = data?.product?.variants ?? []
      for (let i = 0; i < variants.length; i++) {
        const shopVar = variants[i]
        const invItemId = shopVar?.inventory_item_id
        const local = doc.variants[i]
        if (!invItemId || !local?.trackQuantity) continue
        const available = Number(local.stockQty ?? 0)
        await fetch(`${base}/inventory_levels/set.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ location_id: locationId, inventory_item_id: invItemId, available }),
        })
      }
    }
  } catch (e: any) {
    req.payload.logger.error(`Shopify sync error for product ${doc?.id}: ${e?.message || e}`)
  }
}

// -------- Payload collection (tabs without UI components)
const Products: CollectionConfig = {
  slug: 'products',
  admin: { useAsTitle: 'title', description: 'DRIP products synced with Shopify.' },
  hooks: { beforeChange: [formatSlug], afterChange: [syncToShopify] },
  access: { read: () => true },
  fields: [
    {
      type: 'tabs',
      tabs: [
        {
          label: 'Basics',
          fields: [
            { name: 'title', label: 'Title', type: 'text', required: true },
            {
              name: 'slug', label: 'Slug', type: 'text', required: true, unique: true,
              admin: { position: 'sidebar', readOnly: true, description: 'Auto-generated from Title.' },
            },
            { name: 'description', label: 'Description', type: 'richText' },
            {
              name: 'productImages', label: 'Media', type: 'array', minRows: 1, fields: [
                { name: 'image', label: 'Image', type: 'upload', relationTo: 'media', required: true },
              ],
            },
          ],
        },
        {
          label: 'Inventory & Variants',
          fields: [
            {
              name: 'variants',
              label: 'Variants',
              type: 'array',
              required: true,
              minRows: 1,
              admin: {
                description: 'Set prices and compare-at prices per variant below.',
              },
              fields: [
                { type: 'row', fields: [
                  { name: 'size', label: 'Size', type: 'select', options: ['S','M','L','XL','XXL'], required: false, admin: { width: '25%' } },
                  { name: 'color', label: 'Color', type: 'text', required: false, admin: { width: '25%' } },
                  { name: 'sku', label: 'SKU', type: 'text', unique: true, admin: { width: '25%' } },
                  { name: 'barcode', label: 'Barcode', type: 'text', admin: { width: '25%' } },
                ]},
                { type: 'row', fields: [
                  { name: 'price', label: 'Price', type: 'number', required: true, admin: { width: '25%' } },
                  { name: 'compareAtPrice', label: 'Compare-at price', type: 'number', admin: { width: '25%' } },
                  { name: 'taxable', label: 'Charge tax', type: 'checkbox', defaultValue: true, admin: { width: '25%' } },
                  { name: 'trackQuantity', label: 'Track quantity', type: 'checkbox', defaultValue: true, admin: { width: '25%' } },
                ]},
                { type: 'row', fields: [
                  { name: 'stockQty', label: 'Quantity', type: 'number', required: true, defaultValue: 0, admin: { width: '25%' } },
                  { name: 'continueSelling', label: 'Continue selling when out of stock', type: 'checkbox', defaultValue: false, admin: { width: '50%' } },
                ]},
                { type: 'row', fields: [
                  { name: 'requiresShipping', label: 'This is a physical product', type: 'checkbox', defaultValue: true, admin: { width: '33%' } },
                  { name: 'weight', label: 'Weight', type: 'number', admin: { width: '33%' } },
                  { name: 'weightUnit', label: 'Weight unit', type: 'select', options: ['g','kg','oz','lb'], defaultValue: 'kg', admin: { width: '33%' } },
                ]},
              ],
            },
          ],
        },
        {
          label: 'Organization',
          fields: [
            {
              name: 'shopify',
              type: 'group',
              label: 'Shopify fields',
              admin: {
                description:
                  'Publishing to specific sales channels is handled in Shopify. Set Status here; Vendor, Type, Tags, and Collections sync on save.',
              },
              fields: [
                { name: 'status', label: 'Status', type: 'select', options: ['active','draft','archived'], defaultValue: 'active' },
                { name: 'vendor', label: 'Vendor', type: 'text' },
                { name: 'productType', label: 'Type', type: 'text' },
                { name: 'tags', label: 'Tags', type: 'text', hasMany: true },
                { name: 'collectionIds', label: 'Collection IDs', type: 'text', hasMany: true },
                { name: 'productTaxonomyNodeId', label: 'Product taxonomy node id (optional)', type: 'text' },
              ],
            },
            {
              name: 'shopifyProductID',
              label: 'Shopify Product ID',
              type: 'text',
              admin: { description: 'Synced automatically after create.', readOnly: true, position: 'sidebar' },
            },
            { name: 'category', label: 'Local Category (Payload)', type: 'relationship', relationTo: 'categories' },
          ],
        },
        {
          label: 'SEO',
          fields: [
            { name: 'seo', type: 'group', fields: [
              { name: 'title', label: 'SEO title', type: 'text' },
              { name: 'description', label: 'SEO description', type: 'text' },
            ]},
          ],
        },
      ],
    },
  ],
}

export default Products
