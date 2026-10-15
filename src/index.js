// Centro Eureka Hub: Worker principal. Sirve public/ y las rutas /api.
import { manejarApi } from './api.js';
import { respaldar } from './respaldo.js';

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return manejarApi(request, env);
		return env.ASSETS.fetch(request);
	},
	// Respaldo diario (F5): el cron de wrangler.jsonc corre a las 09:00 UTC = 3:00 a. m. en Guadalajara.
	async scheduled(controller, env, ctx) {
		ctx.waitUntil(respaldar(env, { origen: 'cron' }));
	},
};
