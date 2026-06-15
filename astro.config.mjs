// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import vercel from '@astrojs/vercel';
import netlify from '@astrojs/netlify';

// Pick the SSR adapter from the host's build-time env: Netlify sets NETLIFY,
// Vercel sets VERCEL. Default to Vercel when neither is set (local builds).
const adapter = process.env.NETLIFY ? netlify() : vercel();

// https://astro.build/config
export default defineConfig({
	output: 'server',
	adapter,
	vite: {
		plugins: [tailwindcss()],
		// Allow any host (tunnels, LAN IPs, etc.) to reach the dev server.
		server: {
			allowedHosts: true,
		},
	},
});
