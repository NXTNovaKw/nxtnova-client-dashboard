import { CollectionConfig } from 'payload'

const Orders: CollectionConfig = {
  slug: 'orders',
  admin: {
    useAsTitle: 'orderNumber',
    description: 'Manage all customer orders.',
  },
  fields: [
    {
      name: 'orderNumber',
      label: 'Order Number',
      type: 'text',
      required: true,
      unique: true,
      admin: {
        description: 'A unique number to identify this order.',
      },
    },
    {
      name: 'fulfillmentStatus',
      label: 'Fulfillment Status',
      type: 'select',
      options: ['Pending', 'Paid', 'Packed', 'Shipped', 'Delivered', 'Returned'],
      required: true,
      defaultValue: 'Pending',
      admin: {
        position: 'sidebar',
      },
    },
    {
      name: 'customer',
      label: 'Customer',
      type: 'relationship',
      relationTo: 'customers',
      required: true,
      hasMany: false,
    },
    {
      name: 'items',
      label: 'Order Items',
      type: 'array',
      required: true,
      fields: [
        {
          name: 'product',
          label: 'Product',
          type: 'relationship',
          relationTo: 'products',
          required: true,
        },
        {
          name: 'quantity',
          label: 'Quantity',
          type: 'number',
          required: true,
          min: 1,
        },
        {
          name: 'priceAtPurchase',
          label: 'Price at Time of Purchase',
          type: 'number',
          required: true,
          admin: {
            description: 'The price of a single item when the order was placed.',
          },
        },
      ],
    },
  ],
}

export default Orders
