/*
 * Authentication helpers for ks-apiserver-proxy.
 *
 * Historically every inbound handler (proxy middleware, session helpers,
 * controllers) read the access_token directly from `ctx.cookies.get('auth_token')`.
 * That worked for the Dashboard SPA, which puts the token in the cookie
 * after `auth.<host>/api/firstfactor`, but it locked out command-line and
 * SDK clients that follow the BFL/files/market convention of carrying the
 * token in an `X-Authorization` header (envoy edge strips the standard
 * `Authorization` header for BFL hosts but explicitly allow-lists
 * `X-Authorization`).
 *
 * `getAuthToken(ctx)` is the single entry point all inbound auth-token
 * reads should go through. It tries the existing cookie first (so the SPA
 * is unchanged), then falls back to `X-Authorization` so CLI / SDK
 * clients can authenticate without needing to also set a cookie.
 *
 * Returning '' (empty string) on miss matches the historical falsy
 * semantics — every legacy `if (!token) { ... }` guard keeps working
 * verbatim.
 */

const getAuthToken = (ctx) => {
	const cookieTok = ctx.cookies && ctx.cookies.get('auth_token');
	if (cookieTok) return cookieTok;

	const headers = (ctx && ctx.headers) || {};
	const xAuth = headers['x-authorization'];
	if (xAuth) return xAuth;

	return '';
};

module.exports = {
	getAuthToken
};
