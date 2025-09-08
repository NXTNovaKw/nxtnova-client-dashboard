import { CollectionConfig } from 'payload'

const Customers: CollectionConfig = {
  slug: 'customers',
  admin: {
    useAsTitle: 'name',
    description: 'Manage customer information and order history.',
  },
  fields: [
    {
      name: 'name',
      label: 'Full Name',
      type: 'text',
      required: true,
    },
    {
      name: 'email',
      label: 'Email Address',
      type: 'email',
      required: true,
      unique: true,
    },
    {
      name: 'phone',
      label: 'Phone Number',
      type: 'text',
      required: true,
      unique: true,
    },
    {
      name: 'address',
      label: 'Address',
      type: 'text',
      required: true,
    },
    {
      name: 'block',
      label: 'Block',
      type: 'text',
      required: true,
    },
    {
      name: 'street',
      label: 'Street',
      type: 'text',
      required: true,
    },
    {
      name: 'house_number',
      label: 'House Number',
      type: 'text',
      required: true,
    },
    {
      name: 'aad',
      label: 'Aditional Address Detail',
      type: 'text',
    },
    {
      name: 'notes',
      label: 'Customer Notes',
      type: 'textarea',
      admin: {
        description: 'Internal notes about the customer.',
      },
    },
  ],
}

export default Customers
