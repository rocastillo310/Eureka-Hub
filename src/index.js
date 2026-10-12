// Centro Eureka Hub: Worker principal. Sirve public/ y las rutas /api.
import { manejarApi } from './api.js';

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return manejarApi(request, env);
		return env.ASSETS.fetch(request);
	},
};
