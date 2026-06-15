// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import vercel from '@astrojs/vercel';

// https://astro.build/config
export default defineConfig({
	output: 'server',
	adapter: vercel(),
	vite: {
		plugins: [tailwindcss()],
		// Allow any host (tunnels, LAN IPs, etc.) to reach the dev server.
		server: {
			allowedHosts: true,
		},
	},
});
