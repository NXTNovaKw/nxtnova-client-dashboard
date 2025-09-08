import { CollectionConfig } from 'payload'

const Products: CollectionConfig = {
  slug: 'products',
  admin: {
    useAsTitle: 'title',
    description: 'The central collection for all DRIP products and their variants.',
  },
  fields: [
    {
      name: 'title',
      label: 'Product Title',
      type: 'text',
      required: true,
    },
    {
      name: 'shopifyProductID',
      label: 'Shopify Product ID',
      type: 'text',
      required: true,
      unique: true,
      admin: {
        description: 'The ID from the URL of the product in your Shopify admin.',
      },
    },
    {
      name: 'description',
      label: 'Product Description',
      type: 'richText',
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
              required: true,
              admin: {
                width: '33%',
              },
            },
            {
              name: 'color',
              label: 'Color',
              type: 'text',
              required: true,
              admin: {
                width: '33%',
              },
            },
            {
              name: 'price',
              label: 'Price',
              type: 'number',
              required: true,
              admin: {
                width: '33%',
              },
            },
          ],
        },
        {
          name: 'sku',
          label: 'SKU (Stock Keeping Unit)',
          type: 'text',
          unique: true,
        },
        {
          name: 'stockQty',
          label: 'Stock Quantity',
          type: 'number',
          required: true,
          defaultValue: 0,
        },
      ],
    },
  ],
}

export default Products
