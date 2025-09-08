import type { CollectionConfig } from 'payload'

export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
  },
  auth: true,
  fields: [
    {
      name: 'role',
      label: 'Role',
      type: 'select',
      options: [
        { label: 'Brand Owner', value: 'admin' },
        { label: 'Staff', value: 'editor' },
      ],
      required: true,
      defaultValue: 'editor',
      admin: {
        position: 'sidebar',
      },
    },
  ],
}
