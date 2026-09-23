/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { timingSafeEqual } from "node:crypto";

export interface Env {
	TALLY_SIGNING_SECRET: string;
}

async function verifyTallySignature(
	rawBody: string,
	signatureHeader: string | null,
	secret: string
): Promise<boolean> {
	if (!signatureHeader) return false;

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);

	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
	const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));

	return timingSafeEqual(expected, signatureHeader);
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return mismatch === 0;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/hooks/tally" && request.method === "POST") {
			const rawBody = await request.text();
			const signature = request.headers.get("Tally-Signature");

			const valid = await verifyTallySignature(rawBody, signature, env.TALLY_SIGNING_SECRET);
			if (!valid) {
				console.log("Bad Tally signature");
				return new Response("Invalid signature", { status: 401 });
			}

			console.log("Tally payload shape:", rawBody); // remove once you've seen it

			return new Response("OK", { status: 200 });
		}

		return new Response("Not found", { status: 404 });
	},
};