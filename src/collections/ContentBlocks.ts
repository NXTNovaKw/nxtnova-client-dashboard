import { CollectionConfig } from 'payload';

const ContentBlocks: CollectionConfig = {
  slug: 'content-blocks',
  admin: {
    useAsTitle: 'title',
    description: 'A library of reusable content blocks for the storefront.',
  },
  fields: [
    {
      name: 'key',
      label: 'Block Type',
      type: 'select',
      options: [
        { label: 'Homepage Hero', value: 'hero' },
        { label: 'Banner', value: 'banner' },
        { label: 'FAQ Section', value: 'faq' },
        { label: 'Policy Page', value: 'policy' },
        { label: 'Lookbook', value: 'lookbook' },
      ],
      required: true,
      admin: {
        description: 'Select the type of content this block represents.',
      },
    },
    {
      name: 'title',
      label: 'Title',
      type: 'text',
      required: true,
    },
    {
      name: 'body',
      label: 'Body Content',
      type: 'richText',
    },
    {
      name: 'images',
      label: 'Images',
      type: 'array',
      fields: [
        {
          name: 'image',
          type: 'upload',
          relationTo: 'media',
          required: true,
        },
      ],
    },
  ],
};

export default ContentBlocks;