import type { MetadataRoute } from 'next';

/** Installable app (W2.5): agents can add ConversaFlow to their phone's home screen. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ConversaFlow by Meronatic',
    short_name: 'ConversaFlow',
    description: 'One Platform. Every Conversation. Every Customer.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0b2545',
    theme_color: '#0F172A',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
