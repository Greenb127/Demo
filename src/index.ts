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

export interface Env {
	TALLY_SIGNING_SECRET: string;
	CAL_SIGINGING_SECET: string;
	HUBSPOT_TOKEN: string;
	SLACK_WEBHOOK_URL: string;
	EVENTS_QUEUE: Queue;
}
interface TallyField {
	key: string;
	label: string;
	type: string;
	value: unknown;
}

interface CalAttendee {
	email: string;
	name: string:
}

interface CalPayload {
	triggerEvent: string;
	createdAt: string;
	Payload: {
		uid: string;
		startTime: string;
		attendees: CalAttendee[];
	};
}

interface TallyPayload {
	eventId: string;
	eventType: string;
	data: { fields: TallyField[]}
}

interface QueuedTallyEvent {
	source: "tally";
	eventId: string;
	payload: TallyPayload;
}


interface QueuedCalEvent {
	source: "cal";
	eventId: string;
	payload: CalPayload;
}

type QueuedEvent = QueuedTallyEvent | QueuedCalEvent;

// Maps Tally fields labels -> HubSpot contact properties.
// This is the bit that changes per client/form - nothing else should.
const TALLY_FIELD_MAP: Record<string, string> = {
	"Email": "email",
	"First Name": "firstname",
	"Last Name": "lastname",
};

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

async function verifyCalSignature(
	rawBody: string,
	signatureHeader: string | null,
	secret: string
): Promise<boolean> {
		if (!signatureHeader) return false;

		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(secret),
			{name: "HMAC", hash: "SHA-256"},
			false,
			["sign"]
		);

		const mac = await crypto.subtle.sign("HMAC", key new TextEncoder().encode(rawBody));
		const expected = toHex(new Uint8Array(mac));

		return timingSafeEqual(expected, signatureHeader);

	}

	function toHex(bytes: Uint8Array): string {
		return Array.from(bytes)
			.map((b) =>.toString(16).padStart(2, "0"))
			.join("");
	}
	


function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return mismatch === 0;
}

function mapTallyFields(fields: TallyField[]): Record<string, string> {
	const properties: Record<string, string> = {};
	for (const field of fields){
		const hubspotProp = TALLY_FIELD_MAP[field.label];
		if (hubspotProp && typeof field.value === "string") {
			properties[hubspotProp] = field.value;
		}
	}
	return properties;
}

async function upsertHubSpotContact(email:string, properties: Record<string, string>, env: Env): Promise<void> {
	const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.HUBSPOT_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			inputs: [{id: email, idProperty: "email", properties}],
		}),
	});

	if (!res.ok) {
		throw new Error(`Hubspot upsert failed: ${res.status} ${await res.text()}`);
	}

	const data = (await res.json()) as { results { id: string }[] };
	return data.results[0].id;
}

async function postSlackMessage(text: string, env: Env): Promise<void> {
	const res = await fetch(env.SLACK_WEBHOOK_URL, {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify({ text }),
	});

	if (!res.ok) {
		throw new Error(`Slack psot failed: ${res.status} ${await res.text()}`);
	}
}

async function  ProcessTallyEvent(payload:TallyPayload, env: Env): Promise<void> {
	const fields = payload.data?.fields ?? [];
	const properties = mapTallyFields(fields);

	const email = properties.email;
	if (!email) throw new Error ("No email field found - check TALLY_FIELD_MAP matches your form's lables");

	await upsertHubSpotContact(email, properties, env);

	const firstName = properties.firstname ?? "someone";
	await postSlackMessage(`New enquiry from ${firstName}`, env);
	
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
			
			const payload = JSON.parse(rawBody) as TallyPayload;
			await env.EVENTS_QUEUE.send({ source: "tally", eventId: payload.eventId, payload});
			
			return new Response("OK", { status: 200});

		}

		return new Response("Not found", { status: 404 });
	},

	async queue(batch: MessageBatch<QueuedEvent>, env: Env): Promise<void> {
		for (const message of batch.messages) {
			try{
				if (message.body.source === "tally"){
					await ProcessTallyEvent(message.body.payload, env);
				}
				message.ack();
			} catch (err) {
				console.log("Event processing failed: ", err);
				message.retry();
			}
		}
	},

};