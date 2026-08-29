import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { SessionId } from "@deepseek-ai/dsh-session";
import z from "@deepseek-ai/schemastery";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { Buffer as Buffer$1 } from "node:buffer";
//#region src/shared/errors.ts
/** Error whose message contains no credential, provider payload, or user audio. */
var GuardedVoiceError = class extends Error {
	code;
	constructor(code, message) {
		super(message);
		this.code = code;
		this.name = "GuardedVoiceError";
	}
};
function asGuardedVoiceError(error) {
	if (error instanceof GuardedVoiceError) return error;
	return new GuardedVoiceError("invalid-state", "DSH Live Voice operation failed");
}
//#endregion
//#region src/shared/audio.ts
/** PCM16 mono input expected by Qwen realtime. */
const INPUT_PCM_SAMPLE_RATE = 16e3;
/** PCM16 mono output produced by Qwen realtime. */
const OUTPUT_PCM_SAMPLE_RATE = 24e3;
const MAX_INPUT_PCM16_CHUNK_BYTES = 32768;
const MAX_INPUT_PCM16_TURN_BYTES = 30 * INPUT_PCM_SAMPLE_RATE * 2;
const MAX_OUTPUT_PCM16_CHUNK_BYTES = 65536;
const MAX_OUTPUT_PCM16_TURN_BYTES = 60 * OUTPUT_PCM_SAMPLE_RATE * 2;
const MAX_VOICE_TRANSCRIPT_LENGTH = 4096;
/** Maximum queued bulk audio on either browser or provider WebSocket. */
const MAX_VOICE_SOCKET_BUFFERED_BYTES = 524288;
//#endregion
//#region src/shared/wire.ts
const WIRE_VERSION = 1;
const MAX_CONTROL_BYTES = 8192;
const MAX_TRANSCRIPT_LENGTH = MAX_VOICE_TRANSCRIPT_LENGTH;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
function isRecord$2(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyKeys(record, allowed) {
	const allow = new Set(allowed);
	return Object.keys(record).every((key) => allow.has(key));
}
function controlBytes(raw) {
	return new TextEncoder().encode(raw).byteLength;
}
/** Whether an identifier can cross the bounded browser control protocol unchanged. */
function isValidWireId(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
/** Parse one text control frame with an exact, versioned, fail-closed schema. */
function parseClientControl(raw) {
	if (controlBytes(raw) > 8192) throw new GuardedVoiceError("invalid-message", "control frame exceeds the byte limit");
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new GuardedVoiceError("invalid-message", "control frame is not valid JSON");
	}
	if (!isRecord$2(parsed) || parsed.v !== 1 || typeof parsed.type !== "string") throw new GuardedVoiceError("invalid-message", "control frame has an unsupported shape or version");
	if (parsed.type === "bind") {
		if (!hasOnlyKeys(parsed, [
			"v",
			"type",
			"sessionId"
		]) || !isValidWireId(parsed.sessionId)) throw new GuardedVoiceError("invalid-message", "bind frame is invalid");
		return {
			v: 1,
			type: "bind",
			sessionId: parsed.sessionId
		};
	}
	if (parsed.type === "consent.accept") {
		if (!hasOnlyKeys(parsed, [
			"v",
			"type",
			"challenge"
		]) || typeof parsed.challenge !== "string" || !CHALLENGE_PATTERN.test(parsed.challenge)) throw new GuardedVoiceError("invalid-message", "consent frame is invalid");
		return {
			v: 1,
			type: "consent.accept",
			challenge: parsed.challenge
		};
	}
	if (parsed.type === "stop") {
		if (!hasOnlyKeys(parsed, ["v", "type"])) throw new GuardedVoiceError("invalid-message", "stop frame is invalid");
		return {
			v: 1,
			type: "stop"
		};
	}
	if (parsed.type === "turn.commit") {
		if (!hasOnlyKeys(parsed, ["v", "type"])) throw new GuardedVoiceError("invalid-message", "turn commit frame is invalid");
		return {
			v: 1,
			type: "turn.commit"
		};
	}
	throw new GuardedVoiceError("invalid-message", "control frame type is not supported");
}
function encodeServerControl(event) {
	return JSON.stringify(event);
}
function validDisplayString(value, maxLength) {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
/** Parse one Host control event in the browser with an exact, fail-closed schema. */
function parseServerControl(raw) {
	if (controlBytes(raw) > 8192) throw new GuardedVoiceError("invalid-message", "server control frame exceeds the byte limit");
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new GuardedVoiceError("invalid-message", "server control frame is not valid JSON");
	}
	if (!isRecord$2(parsed) || parsed.v !== 1 || typeof parsed.type !== "string") throw new GuardedVoiceError("invalid-message", "server control frame has an unsupported shape or version");
	if (parsed.type === "consent.required") {
		if (!hasOnlyKeys(parsed, [
			"v",
			"type",
			"challenge",
			"expiresAt",
			"sessionId",
			"workspaceId",
			"provider",
			"disclosure"
		]) || typeof parsed.challenge !== "string" || !CHALLENGE_PATTERN.test(parsed.challenge) || typeof parsed.expiresAt !== "number" || !Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt <= 0 || !isValidWireId(parsed.sessionId) || !isValidWireId(parsed.workspaceId) || parsed.provider !== "qwen" || !isRecord$2(parsed.disclosure) || !hasOnlyKeys(parsed.disclosure, [
			"audioDestination",
			"exportedContext",
			"executionAuthority",
			"providerRetention",
			"currentMilestone"
		]) || parsed.disclosure.audioDestination !== "Alibaba Cloud Qwen realtime API" || parsed.disclosure.exportedContext !== "none" || parsed.disclosure.executionAuthority !== "none" || parsed.disclosure.providerRetention !== "not specified for Qwen realtime audio" || parsed.disclosure.currentMilestone !== "one bounded manual audio turn after acceptance") throw new GuardedVoiceError("invalid-message", "consent-required event is invalid");
		return {
			v: 1,
			type: "consent.required",
			challenge: parsed.challenge,
			expiresAt: parsed.expiresAt,
			sessionId: parsed.sessionId,
			workspaceId: parsed.workspaceId,
			provider: "qwen",
			disclosure: {
				audioDestination: "Alibaba Cloud Qwen realtime API",
				exportedContext: "none",
				executionAuthority: "none",
				providerRetention: "not specified for Qwen realtime audio",
				currentMilestone: "one bounded manual audio turn after acceptance"
			}
		};
	}
	if (parsed.type === "ready") {
		if (!hasOnlyKeys(parsed, [
			"v",
			"type",
			"sessionId",
			"workspaceId",
			"provider",
			"model",
			"authority"
		]) || !isValidWireId(parsed.sessionId) || !isValidWireId(parsed.workspaceId) || parsed.provider !== "qwen" || !validDisplayString(parsed.model, 128) || parsed.authority !== "proposal-only") throw new GuardedVoiceError("invalid-message", "ready event is invalid");
		return {
			v: 1,
			type: "ready",
			sessionId: parsed.sessionId,
			workspaceId: parsed.workspaceId,
			provider: "qwen",
			model: parsed.model,
			authority: "proposal-only"
		};
	}
	if (parsed.type === "error") {
		if (!hasOnlyKeys(parsed, [
			"v",
			"type",
			"code",
			"message"
		]) || !validDisplayString(parsed.code, 64) || !validDisplayString(parsed.message, 2048)) throw new GuardedVoiceError("invalid-message", "error event is invalid");
		return {
			v: 1,
			type: "error",
			code: parsed.code,
			message: parsed.message
		};
	}
	if (parsed.type === "stopped") {
		if (!hasOnlyKeys(parsed, ["v", "type"])) throw new GuardedVoiceError("invalid-message", "stopped event is invalid");
		return {
			v: 1,
			type: "stopped"
		};
	}
	if (parsed.type === "transcript") {
		if (!hasOnlyKeys(parsed, [
			"v",
			"type",
			"role",
			"text",
			"final"
		]) || parsed.role !== "user" && parsed.role !== "assistant" || typeof parsed.text !== "string" || parsed.text.length > MAX_TRANSCRIPT_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(parsed.text) || typeof parsed.final !== "boolean") throw new GuardedVoiceError("invalid-message", "transcript event is invalid");
		return {
			v: 1,
			type: "transcript",
			role: parsed.role,
			text: parsed.text,
			final: parsed.final
		};
	}
	if (parsed.type === "turn.done") {
		if (!hasOnlyKeys(parsed, [
			"v",
			"type",
			"status"
		]) || parsed.status !== "completed" && parsed.status !== "cancelled") throw new GuardedVoiceError("invalid-message", "turn-done event is invalid");
		return {
			v: 1,
			type: "turn.done",
			status: parsed.status
		};
	}
	throw new GuardedVoiceError("invalid-message", "server control frame type is not supported");
}
//#endregion
//#region src/host/authority.ts
/** Exact session/workspace authority boundary for one voice connection. */
var AuthorityGuard = class {
	sessions;
	workspaces;
	constructor(sessions, workspaces) {
		this.sessions = sessions;
		this.workspaces = workspaces;
	}
	bind(sessionId) {
		const sessionIdentity = this.sessions.get(sessionId);
		if (sessionIdentity === void 0) throw new GuardedVoiceError("session-not-live", "the requested session is not live");
		const matches = this.workspaces.list().filter((workspace) => workspace.sessionIds.includes(sessionId));
		if (matches.length === 0) throw new GuardedVoiceError("workspace-not-found", "the session is not attached to a workspace");
		if (matches.length !== 1) throw new GuardedVoiceError("authority-ambiguous", "the session is attached to more than one workspace");
		const [workspace] = matches;
		if (workspace === void 0) throw new GuardedVoiceError("workspace-not-found", "the session is not attached to a workspace");
		const workspaceId = String(workspace.id);
		if (!isValidWireId(workspaceId)) throw new GuardedVoiceError("invalid-state", "the workspace identifier is not safe for the browser protocol");
		return {
			binding: {
				sessionId,
				workspaceId
			},
			sessionIdentity
		};
	}
	revalidate(lease) {
		if (this.sessions.get(lease.binding.sessionId) !== lease.sessionIdentity) throw new GuardedVoiceError("authority-changed", "the bound session is no longer the same live session");
		const matches = this.workspaces.list().filter((workspace) => workspace.sessionIds.includes(lease.binding.sessionId));
		const workspaceId = String(matches[0]?.id);
		if (matches.length !== 1 || !isValidWireId(workspaceId) || workspaceId !== lease.binding.workspaceId) throw new GuardedVoiceError("authority-changed", "the bound workspace membership changed");
		return lease.binding;
	}
};
//#endregion
//#region src/shared/boot.ts
const CLIENT_BOOT_GLOBAL = "__DSH_GUARDED_LIVE_VOICE__";
const CLIENT_BOOT_VERSION = 1;
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Validate the non-secret Host-to-browser route descriptor. */
function parseGuardedVoiceClientBoot(value) {
	if (!isRecord$1(value) || Object.keys(value).some((key) => key !== "v" && key !== "route") || value.v !== 1 || typeof value.route !== "string" || !/^\/[A-Za-z0-9._~-]+$/u.test(value.route) || value.route === "/." || value.route === "/..") throw new TypeError("DSH Live Voice browser bootstrap is invalid");
	return {
		v: 1,
		route: value.route
	};
}
//#endregion
//#region src/host/boot.ts
/** Publish only the non-secret browser route through DSH's structured boot table. */
function guardedVoiceClientBootInjection(route) {
	const value = parseGuardedVoiceClientBoot({
		v: 1,
		route
	});
	return {
		kind: "global",
		name: CLIENT_BOOT_GLOBAL,
		value
	};
}
//#endregion
//#region src/host/carrier.ts
const ACCEPTED = { ok: true };
function oneHeader(headers, name) {
	const value = headers[name];
	if (Array.isArray(value)) return void 0;
	return value;
}
function parseAuthority(raw) {
	if (raw.includes("/") || raw.includes("\\") || /[\u0000-\u0020\u007f]/u.test(raw)) return void 0;
	try {
		const value = new URL(`http://${raw}`);
		if (value.username !== "" || value.password !== "" || value.pathname !== "/" || value.search !== "" || value.hash !== "") return void 0;
		return value;
	} catch {
		return;
	}
}
function isTrustedHost(requested, trustedHosts) {
	return trustedHosts.some((entry) => {
		const trusted = parseAuthority(entry);
		if (trusted === void 0) return false;
		if (trusted.hostname.toLowerCase() !== requested.hostname.toLowerCase()) return false;
		return trusted.port === "" || trusted.port === requested.port;
	});
}
function isLoopbackAddress(address) {
	if (address === void 0) return false;
	const normalized = address.toLowerCase().split("%", 1)[0];
	return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}
/** Loopback-only, same-origin, explicit-host fence for the privileged WebSocket. */
function assessUpgradeRequest(request, trustedHosts) {
	if (!isLoopbackAddress(request.remoteAddress)) return {
		ok: false,
		status: 403,
		reason: "DSH Live Voice is loopback-only"
	};
	if (request.method !== "GET") return {
		ok: false,
		status: 400,
		reason: "websocket upgrade must use GET"
	};
	const upgrade = oneHeader(request.headers, "upgrade")?.toLowerCase();
	const connection = oneHeader(request.headers, "connection")?.toLowerCase().split(",").map((value) => value.trim());
	if (upgrade !== "websocket" || !connection?.includes("upgrade")) return {
		ok: false,
		status: 426,
		reason: "websocket upgrade required"
	};
	if (oneHeader(request.headers, "sec-websocket-version") !== "13") return {
		ok: false,
		status: 426,
		reason: "websocket version 13 required"
	};
	const hostRaw = oneHeader(request.headers, "host");
	const requested = hostRaw === void 0 ? void 0 : parseAuthority(hostRaw);
	if (requested === void 0 || !isTrustedHost(requested, trustedHosts)) return {
		ok: false,
		status: 403,
		reason: "host is not trusted"
	};
	const originRaw = oneHeader(request.headers, "origin");
	let origin;
	try {
		origin = new URL(originRaw ?? "");
	} catch {
		return {
			ok: false,
			status: 403,
			reason: "origin is required"
		};
	}
	if (!["http:", "https:"].includes(origin.protocol) || origin.username !== "" || origin.password !== "" || origin.host.toLowerCase() !== requested.host.toLowerCase()) return {
		ok: false,
		status: 403,
		reason: "origin does not match host"
	};
	const fetchSite = oneHeader(request.headers, "sec-fetch-site")?.toLowerCase();
	if (fetchSite !== void 0 && fetchSite !== "same-origin") return {
		ok: false,
		status: 403,
		reason: "cross-site websocket is forbidden"
	};
	return ACCEPTED;
}
function assertTrustedHosts(trustedHosts) {
	if (trustedHosts.length === 0) throw new TypeError("at least one trusted host is required");
	for (const host of trustedHosts) if (parseAuthority(host) === void 0) throw new TypeError(`invalid trusted host: ${host}`);
}
function rejectUpgrade(socket, assessment) {
	const statusText = assessment.status === 403 ? "Forbidden" : assessment.status === 429 ? "Too Many Requests" : assessment.status === 426 ? "Upgrade Required" : "Bad Request";
	socket.end(`HTTP/1.1 ${assessment.status} ${statusText}\r\nConnection: close\r
Content-Type: text/plain; charset=utf-8\r
Content-Length: 0\r
\r
`);
}
/** Mirror Harness Connection's authenticated WebSocket rejection contract. */
function rejectConnectionUpgrade(socket, status) {
	const reason = status === 401 ? "Unauthorized" : "Forbidden";
	const body = reason.toLowerCase();
	socket.end([
		`HTTP/1.1 ${String(status)} ${reason}`,
		"Connection: close",
		"Content-Type: text/plain; charset=utf-8",
		`Content-Length: ${String(Buffer.byteLength(body))}`,
		"",
		body
	].join("\r\n"));
}
//#endregion
//#region src/host/consent.ts
const sameSubject = (left, right) => left.connectionId === right.connectionId && left.sessionId === right.sessionId && left.workspaceId === right.workspaceId && left.provider === right.provider;
/** Short-lived, one-shot proof that the exact bound connection accepted disclosure. */
var ConsentChallenges = class {
	records = /* @__PURE__ */ new Map();
	ttlMs;
	now;
	token;
	constructor(options = {}) {
		this.ttlMs = options.ttlMs ?? 6e4;
		if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1e3 || this.ttlMs > 3e5) throw new TypeError("consent ttl must be an integer between 1 and 300 seconds");
		this.now = options.now ?? Date.now;
		this.token = options.token ?? (() => randomBytes(32).toString("base64url"));
	}
	issue(subject) {
		this.sweep();
		const challenge = this.token();
		if (!CHALLENGE_PATTERN.test(challenge) || this.records.has(challenge)) throw new Error("consent token source produced an invalid or duplicate challenge");
		const stored = {
			challenge,
			expiresAt: this.now() + this.ttlMs,
			subject: { ...subject }
		};
		this.records.set(challenge, stored);
		return {
			challenge: stored.challenge,
			expiresAt: stored.expiresAt
		};
	}
	consume(challenge, subject) {
		if (!CHALLENGE_PATTERN.test(challenge)) throw new GuardedVoiceError("consent-invalid", "consent challenge is invalid");
		const stored = this.records.get(challenge);
		if (stored === void 0) throw new GuardedVoiceError("consent-invalid", "consent challenge is unknown or already used");
		this.records.delete(challenge);
		if (this.now() >= stored.expiresAt) throw new GuardedVoiceError("consent-expired", "consent challenge expired");
		if (!sameSubject(stored.subject, subject)) throw new GuardedVoiceError("consent-invalid", "consent challenge belongs to a different binding");
	}
	revoke(challenge) {
		this.records.delete(challenge);
	}
	sweep() {
		const now = this.now();
		let removed = 0;
		for (const [challenge, record] of this.records) {
			if (now < record.expiresAt) continue;
			this.records.delete(challenge);
			removed += 1;
		}
		return removed;
	}
	get size() {
		return this.records.size;
	}
};
//#endregion
//#region src/host/qwen.ts
const QWEN_REALTIME_MODELS = ["qwen-audio-3.0-realtime-plus", "qwen-audio-3.0-realtime-flash"];
const DEFAULT_QWEN_REALTIME_MODEL = "qwen-audio-3.0-realtime-plus";
const WORKSPACE_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
function isQwenRealtimeModel(value) {
	return QWEN_REALTIME_MODELS.includes(value);
}
/** Construct the documented China/Beijing endpoint without accepting arbitrary hosts. */
function buildQwenRealtimeEndpoint(dashscopeWorkspaceId, model) {
	if (!WORKSPACE_LABEL.test(dashscopeWorkspaceId)) throw new GuardedVoiceError("provider-unconfigured", "DashScope workspace id is missing or invalid");
	if (!isQwenRealtimeModel(model)) throw new GuardedVoiceError("provider-unconfigured", "Qwen realtime model is not supported");
	const endpoint = new URL(`wss://${dashscopeWorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime`);
	endpoint.searchParams.set("model", model);
	return endpoint;
}
const MAX_QWEN_PROVIDER_CONTROL_BYTES = 65536;
function parseProviderEvent(raw) {
	if (new TextEncoder().encode(raw).byteLength > 65536) throw new GuardedVoiceError("invalid-message", "provider control event exceeds the byte limit");
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new GuardedVoiceError("invalid-message", "provider control event is not valid JSON");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new GuardedVoiceError("invalid-message", "provider control event has an invalid shape");
	const event = parsed;
	if (typeof event.type !== "string") throw new GuardedVoiceError("invalid-message", "provider control event has no type");
	return event;
}
function parseSessionIdentity(event, expectedModel) {
	const session = event.session;
	if (session === null || typeof session !== "object" || Array.isArray(session)) throw new GuardedVoiceError("invalid-message", "Qwen session event has no session object");
	const record = session;
	if (record.object !== "realtime.session") throw new GuardedVoiceError("invalid-message", "Qwen session event has an invalid object type");
	if (typeof record.id !== "string" || record.id.length === 0 || record.id.length > 256) throw new GuardedVoiceError("invalid-message", "Qwen session event has an invalid id");
	if (typeof record.model !== "string" || !isQwenRealtimeModel(record.model)) throw new GuardedVoiceError("invalid-message", "Qwen session event has an invalid model");
	if (expectedModel !== void 0 && record.model !== expectedModel) throw new GuardedVoiceError("invalid-state", "Qwen session model does not match the request");
	return {
		id: record.id,
		model: record.model,
		session: record
	};
}
function hasExpectedUpdatedSession(actual, expected) {
	return Array.isArray(actual.modalities) && actual.modalities.length === expected.modalities.length && actual.modalities.every((value, index) => value === expected.modalities[index]) && actual.turn_detection === expected.turnDetection && (expected.inputAudioFormat === void 0 || actual.input_audio_format === expected.inputAudioFormat) && (expected.outputAudioFormat === void 0 || actual.output_audio_format === expected.outputAudioFormat);
}
/**
* Enforces the documented session.created -> session.update ->
* session.updated ordering. Callers supply the update body and may require the
* provider to confirm an exact model and effective session configuration.
*/
var QwenHandshake = class {
	phase = "awaiting-created";
	sessionUpdate;
	expectedModel;
	expectedUpdatedSession;
	sessionIdentity;
	constructor(sessionUpdate, expectedModel, expectedUpdatedSession) {
		if ("type" in sessionUpdate) throw new TypeError("session update body must not override the event type");
		this.sessionUpdate = structuredClone(sessionUpdate);
		this.expectedModel = expectedModel;
		this.expectedUpdatedSession = expectedUpdatedSession === void 0 ? void 0 : {
			modalities: [...expectedUpdatedSession.modalities],
			turnDetection: expectedUpdatedSession.turnDetection,
			...expectedUpdatedSession.inputAudioFormat === void 0 ? {} : { inputAudioFormat: expectedUpdatedSession.inputAudioFormat },
			...expectedUpdatedSession.outputAudioFormat === void 0 ? {} : { outputAudioFormat: expectedUpdatedSession.outputAudioFormat }
		};
	}
	receive(raw) {
		if (this.phase === "closed") throw new GuardedVoiceError("invalid-state", "provider handshake is closed");
		const event = parseProviderEvent(raw);
		if (event.type === "error") {
			this.phase = "closed";
			throw new GuardedVoiceError("invalid-state", "Qwen rejected the realtime session");
		}
		if (this.phase === "awaiting-created" && event.type === "session.created") {
			this.sessionIdentity = parseSessionIdentity(event, this.expectedModel);
			this.phase = "awaiting-updated";
			return {
				kind: "send",
				payload: {
					...this.sessionUpdate,
					type: "session.update"
				}
			};
		}
		if (this.phase === "awaiting-updated" && event.type === "session.updated") {
			const updatedIdentity = parseSessionIdentity(event, this.expectedModel);
			if (this.sessionIdentity === void 0 || updatedIdentity.id !== this.sessionIdentity.id || updatedIdentity.model !== this.sessionIdentity.model) {
				this.phase = "closed";
				throw new GuardedVoiceError("invalid-state", "Qwen session identity changed during the handshake");
			}
			if (this.expectedUpdatedSession !== void 0 && !hasExpectedUpdatedSession(updatedIdentity.session, this.expectedUpdatedSession)) {
				this.phase = "closed";
				throw new GuardedVoiceError("invalid-state", "Qwen session configuration does not match the request");
			}
			this.phase = "ready";
			return { kind: "ready" };
		}
		throw new GuardedVoiceError("invalid-state", "Qwen realtime handshake event arrived out of order");
	}
	assertReady() {
		if (this.phase !== "ready") throw new GuardedVoiceError("invalid-state", "Qwen realtime session is not ready");
	}
	close() {
		this.phase = "closed";
	}
};
const MAX_QWEN_READY_TIMEOUT_MS = 6e4;
//#endregion
//#region src/host/qwen-manual-turn.ts
const MAX_QWEN_INPUT_CHUNK_BYTES = MAX_INPUT_PCM16_CHUNK_BYTES;
const MAX_QWEN_INPUT_TURN_BYTES = MAX_INPUT_PCM16_TURN_BYTES;
const MAX_QWEN_OUTPUT_CHUNK_BYTES = MAX_OUTPUT_PCM16_CHUNK_BYTES;
const MAX_QWEN_OUTPUT_TURN_BYTES = MAX_OUTPUT_PCM16_TURN_BYTES;
const MAX_QWEN_TRANSCRIPT_LENGTH = MAX_VOICE_TRANSCRIPT_LENGTH;
const MAX_QWEN_REALTIME_EVENT_BYTES = 262144;
const MAX_QWEN_BUFFERED_BYTES = MAX_VOICE_SOCKET_BUFFERED_BYTES;
const DEFAULT_QWEN_INPUT_TIMEOUT_MS = 6e4;
const DEFAULT_QWEN_RESPONSE_TIMEOUT_MS = 9e4;
const MAX_QWEN_PHASE_TIMEOUT_MS = 3e5;
function defaultCreateSocket(endpoint, options) {
	return new WebSocket(endpoint, {
		followRedirects: false,
		handshakeTimeout: options.handshakeTimeoutMs,
		headers: { Authorization: options.authorization },
		maxPayload: options.maxPayload,
		perMessageDeflate: false
	});
}
function checkedTimeout(value) {
	const timeout = value ?? 1e4;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 6e4) throw new TypeError(`Qwen ready timeout must be an integer from 1 to ${MAX_QWEN_READY_TIMEOUT_MS}`);
	return timeout;
}
function checkedPhaseTimeout(value, fallback, name) {
	const timeout = value ?? fallback;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3e5) throw new TypeError(`${name} must be an integer from 1 to ${MAX_QWEN_PHASE_TIMEOUT_MS}`);
	return timeout;
}
function authorizationOf(value) {
	if (value === void 0 || value.length === 0 || /[\r\n]/u.test(value) || Buffer$1.byteLength(value, "utf8") > 4096) throw new GuardedVoiceError("provider-unconfigured", "DashScope credential is missing or invalid");
	return `Bearer ${value}`;
}
function bytesOf(raw) {
	if (Array.isArray(raw)) return Buffer$1.concat(raw);
	if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
	return raw;
}
function recordOf(value, message) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new GuardedVoiceError("invalid-message", message);
	return value;
}
function boundedString(value, name, allowEmpty = false) {
	if (typeof value !== "string" || !allowEmpty && value.length === 0 || value.length > MAX_QWEN_TRANSCRIPT_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new GuardedVoiceError("invalid-message", `Qwen ${name} is invalid`);
	return value;
}
function strictBase64(value) {
	if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw new GuardedVoiceError("invalid-message", "Qwen audio delta is not canonical base64");
	const decoded = Buffer$1.from(value, "base64");
	if (decoded.byteLength === 0 || decoded.byteLength > MAX_QWEN_OUTPUT_CHUNK_BYTES || decoded.byteLength % 2 !== 0 || decoded.toString("base64") !== value) throw new GuardedVoiceError("invalid-message", "Qwen audio delta is invalid");
	return new Uint8Array(decoded);
}
function assertTranscriptFitsWire(value) {
	const envelope = JSON.stringify({
		v: 1,
		type: "transcript",
		role: "assistant",
		text: value,
		final: false
	});
	if (Buffer$1.byteLength(envelope, "utf8") > 8192) throw new GuardedVoiceError("invalid-message", "Qwen transcript exceeds the browser control byte limit");
}
function parseEvent(raw) {
	if (raw.byteLength > 262144) throw new GuardedVoiceError("invalid-message", "Qwen realtime event exceeds the byte limit");
	let parsed;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
	} catch {
		throw new GuardedVoiceError("invalid-message", "Qwen realtime event is not valid JSON");
	}
	const event = recordOf(parsed, "Qwen realtime event has an invalid shape");
	if (typeof event.type !== "string") throw new GuardedVoiceError("invalid-message", "Qwen realtime event has no type");
	return event;
}
/**
* Open one audio-enabled, push-to-talk Qwen session.
*
* The returned capability accepts one bounded PCM16 mono/16 kHz turn, exposes
* only bounded transcripts and PCM16 mono/24 kHz output, and has no tool,
* context-injection, text-input, or second-turn operation.
*/
function openQwenManualTurn(options, dependencies = {}) {
	const timeoutMs = checkedTimeout(options.readyTimeoutMs);
	const inputTimeoutMs = checkedPhaseTimeout(options.inputTimeoutMs, DEFAULT_QWEN_INPUT_TIMEOUT_MS, "Qwen input timeout");
	const responseTimeoutMs = checkedPhaseTimeout(options.responseTimeoutMs, DEFAULT_QWEN_RESPONSE_TIMEOUT_MS, "Qwen response timeout");
	const endpoint = buildQwenRealtimeEndpoint(options.workspaceId, options.model);
	const createSocket = dependencies.createSocket ?? defaultCreateSocket;
	const schedule = dependencies.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
	const cancelScheduled = dependencies.cancelScheduled ?? ((timer) => clearTimeout(timer));
	const operation = new AbortController();
	const handshake = new QwenHandshake({ session: {
		modalities: ["text", "audio"],
		input_audio_format: "pcm",
		output_audio_format: "pcm",
		turn_detection: null
	} }, options.model, {
		modalities: ["text", "audio"],
		turnDetection: null,
		inputAudioFormat: "pcm",
		outputAudioFormat: "pcm"
	});
	let state = "opening";
	let socket;
	let readyTimer;
	let phaseTimer;
	let forceCloseTimer;
	let closeReason = "transport-error";
	let inputBytes = 0;
	let outputBytes = 0;
	let inputCommitted = false;
	let inputItemId;
	let inputContentIndex;
	let responseId;
	let assistantItemId;
	let outputIndex;
	let contentIndex;
	let userStable = "";
	let userTranscript = "";
	let userTranscriptFinal = false;
	let assistantTranscript = "";
	let assistantTranscriptFinal = false;
	let assistantAudioDone = false;
	let responseDone = false;
	const listeners = /* @__PURE__ */ new Set();
	let resolveClosed = () => {};
	const closed = new Promise((resolve) => {
		resolveClosed = resolve;
	});
	let resolveOpened = () => {};
	let rejectOpened = () => {};
	const opened = new Promise((resolve, reject) => {
		resolveOpened = resolve;
		rejectOpened = reject;
	});
	const emit = (event) => {
		for (const listener of [...listeners]) listener(event);
	};
	const send = (payload) => {
		const encoded = JSON.stringify(payload);
		if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount + Buffer$1.byteLength(encoded, "utf8") > MAX_QWEN_BUFFERED_BYTES) throw new GuardedVoiceError("invalid-state", "Qwen realtime transport is not writable");
		socket.send(encoded, (error) => {
			if (error != null) beginClose("transport-error");
		});
	};
	const detach = () => {
		socket?.off("message", onMessage);
		socket?.off("error", onError);
		socket?.off("close", onClose);
	};
	const completeClose = () => {
		if (state === "closed") return;
		state = "closed";
		if (forceCloseTimer !== void 0) {
			cancelScheduled(forceCloseTimer);
			forceCloseTimer = void 0;
		}
		socket?.off("error", onCleanupError);
		socket?.off("close", onCleanupClose);
		listeners.clear();
		resolveClosed(closeReason);
	};
	const beginClose = (reason, openingFailure, graceful = false) => {
		if (state === "closing" || state === "closed") return;
		const previous = state;
		state = "closing";
		closeReason = reason;
		handshake.close();
		if (!operation.signal.aborted) operation.abort();
		options.signal.removeEventListener("abort", onAbort);
		if (readyTimer !== void 0) {
			cancelScheduled(readyTimer);
			readyTimer = void 0;
		}
		if (phaseTimer !== void 0) {
			cancelScheduled(phaseTimer);
			phaseTimer = void 0;
		}
		detach();
		if (previous === "opening") rejectOpened(openingFailure ?? new GuardedVoiceError("invalid-state", "Qwen realtime session failed"));
		if (socket === void 0 || socket.readyState === WebSocket.CLOSED) {
			completeClose();
			return;
		}
		socket.once("error", onCleanupError);
		socket.once("close", onCleanupClose);
		try {
			if (graceful && socket.readyState === WebSocket.OPEN) {
				socket.close(1e3);
				forceCloseTimer = schedule(() => {
					forceCloseTimer = void 0;
					try {
						if (socket?.readyState !== WebSocket.CLOSED) socket?.terminate();
					} catch {
						completeClose();
					}
				}, 250);
			} else socket.terminate();
		} catch {
			completeClose();
		}
	};
	const failProtocol = () => {
		beginClose("protocol-error", new GuardedVoiceError("invalid-state", "Qwen realtime protocol failed"));
	};
	const assertResponseIdentity = (event) => {
		if (state !== "response" || responseId === void 0) throw new GuardedVoiceError("invalid-state", "Qwen output arrived before response.created");
		const id = boundedString(event.response_id, "response id");
		if (responseId !== id) throw new GuardedVoiceError("invalid-state", "Qwen response identity changed");
	};
	const exactIndex = (value, name) => {
		if (value !== 0) throw new GuardedVoiceError("invalid-message", `Qwen ${name} is invalid`);
		return 0;
	};
	const setExact = (current, next, message) => {
		if (current !== void 0 && current !== next) throw new GuardedVoiceError("invalid-state", message);
		return next;
	};
	const assertOutputIdentity = (event) => {
		assertResponseIdentity(event);
		assistantItemId = setExact(assistantItemId, boundedString(event.item_id, "assistant item id"), "Qwen assistant item identity changed");
		outputIndex = setExact(outputIndex, exactIndex(event.output_index, "output index"), "Qwen output index changed");
		contentIndex = setExact(contentIndex, exactIndex(event.content_index, "content index"), "Qwen content index changed");
	};
	const hasAudioModalities = (value) => Array.isArray(value) && value.length === 2 && value[0] === "text" && value[1] === "audio";
	const validateOutputItem = (value, completed) => {
		const item = recordOf(value, "Qwen response output item is missing");
		if (item.object !== "realtime.item" || item.type !== "message" || item.role !== "assistant") throw new GuardedVoiceError("invalid-state", "Qwen attempted a non-message output capability");
		if (completed && item.status !== "completed") throw new GuardedVoiceError("invalid-state", "Qwen assistant output did not complete");
		assistantItemId = setExact(assistantItemId, boundedString(item.id, "assistant item id"), "Qwen assistant item identity changed");
		if (!Array.isArray(item.content) || item.content.length > 1 || completed && item.content.length !== 1) throw new GuardedVoiceError("invalid-state", "Qwen assistant content shape is invalid");
		if (item.content.length === 1) {
			const part = recordOf(item.content[0], "Qwen assistant audio content is missing");
			if (part.type !== "audio") throw new GuardedVoiceError("invalid-state", "Qwen attempted a non-audio content capability");
			if (completed) {
				const transcript = boundedString(part.transcript, "completed output transcript", true);
				if (!assistantTranscriptFinal || transcript !== assistantTranscript) throw new GuardedVoiceError("invalid-state", "Qwen completed transcript identity changed");
			}
		}
	};
	const publishUserTranscript = (event, final) => {
		if (state !== "response") throw new GuardedVoiceError("invalid-state", "Qwen input transcript arrived before commit");
		const itemId = boundedString(event.item_id, "input item id");
		if (inputItemId === void 0) inputItemId = itemId;
		else if (inputItemId !== itemId) throw new GuardedVoiceError("invalid-state", "Qwen input item identity changed");
		inputContentIndex = setExact(inputContentIndex, exactIndex(event.content_index, "input content index"), "Qwen input content index changed");
		if (userTranscriptFinal) throw new GuardedVoiceError("invalid-state", "Qwen input transcript changed after completion");
		if (final) {
			const transcript = boundedString(event.transcript, "input transcript", true);
			if (transcript.length > MAX_QWEN_TRANSCRIPT_LENGTH) throw new GuardedVoiceError("invalid-message", "Qwen input transcript exceeds the limit");
			userStable = transcript;
			userTranscript = transcript;
			userTranscriptFinal = true;
		} else {
			const text = boundedString(event.text, "input transcript delta", true);
			const stash = boundedString(event.stash, "input transcript stash", true);
			if (text.length + stash.length > MAX_QWEN_TRANSCRIPT_LENGTH) throw new GuardedVoiceError("invalid-message", "Qwen input transcript exceeds the limit");
			userStable = text;
			userTranscript = userStable + stash;
		}
		assertTranscriptFitsWire(userTranscript);
		emit({
			type: "transcript",
			role: "user",
			text: userTranscript,
			final
		});
	};
	const publishAssistantTranscript = (event, final) => {
		assertOutputIdentity(event);
		if (assistantTranscriptFinal) throw new GuardedVoiceError("invalid-state", "Qwen output transcript changed after completion");
		if (final) {
			const transcript = boundedString(event.transcript, "output transcript", true);
			if (transcript.length > MAX_QWEN_TRANSCRIPT_LENGTH) throw new GuardedVoiceError("invalid-message", "Qwen output transcript exceeds the limit");
			assistantTranscript = transcript;
			assistantTranscriptFinal = true;
		} else {
			const delta = boundedString(event.delta, "output transcript delta", true);
			if (assistantTranscript.length + delta.length > MAX_QWEN_TRANSCRIPT_LENGTH) throw new GuardedVoiceError("invalid-message", "Qwen output transcript exceeds the limit");
			assistantTranscript += delta;
		}
		assertTranscriptFitsWire(assistantTranscript);
		emit({
			type: "transcript",
			role: "assistant",
			text: assistantTranscript,
			final
		});
	};
	const handleReadyEvent = (event) => {
		if (state === "done") throw new GuardedVoiceError("invalid-state", "Qwen emitted data after the terminal response");
		switch (event.type) {
			case "input_audio_buffer.committed": {
				if (state !== "response" || inputCommitted) throw new GuardedVoiceError("invalid-state", "Qwen input commit arrived out of order");
				const itemId = boundedString(event.item_id, "committed item id");
				if (inputItemId === void 0) inputItemId = itemId;
				else if (inputItemId !== itemId) throw new GuardedVoiceError("invalid-state", "Qwen input item identity changed");
				inputCommitted = true;
				return;
			}
			case "conversation.item.input_audio_transcription.delta":
				publishUserTranscript(event, false);
				return;
			case "conversation.item.input_audio_transcription.completed":
				publishUserTranscript(event, true);
				return;
			case "response.created": {
				if (state !== "response" || responseId !== void 0) throw new GuardedVoiceError("invalid-state", "Qwen response began out of order");
				const response = recordOf(event.response, "Qwen response.created has no response");
				if (response.object !== "realtime.response" || response.status !== "in_progress" || !hasAudioModalities(response.modalities) || !Array.isArray(response.output) || response.output.length !== 0) throw new GuardedVoiceError("invalid-state", "Qwen response.created is not the requested audio response");
				const id = boundedString(response.id, "response id");
				if (responseId !== void 0 && responseId !== id) throw new GuardedVoiceError("invalid-state", "Qwen response identity changed");
				responseId = id;
				return;
			}
			case "response.output_item.added":
			case "response.output_item.done": {
				assertResponseIdentity(event);
				outputIndex = setExact(outputIndex, exactIndex(event.output_index, "output index"), "Qwen output index changed");
				const item = recordOf(event.item, "Qwen output item is missing");
				if (item.type !== "message" || item.role !== "assistant") throw new GuardedVoiceError("invalid-state", "Qwen attempted a non-message output capability");
				assistantItemId = setExact(assistantItemId, boundedString(item.id, "assistant item id"), "Qwen assistant item identity changed");
				return;
			}
			case "response.content_part.added":
			case "response.content_part.done":
				assertOutputIdentity(event);
				if (recordOf(event.part, "Qwen response content part is missing").type !== "audio") throw new GuardedVoiceError("invalid-state", "Qwen attempted a non-audio content capability");
				return;
			case "conversation.item.created": {
				const item = recordOf(event.item, "Qwen conversation item is missing");
				const itemId = boundedString(item.id, "conversation item id");
				if (item.type !== "message" || item.role !== "user" && item.role !== "assistant") throw new GuardedVoiceError("invalid-state", "Qwen attempted a non-message conversation capability");
				if (item.role === "user") {
					if (state !== "response") throw new GuardedVoiceError("invalid-state", "Qwen user item arrived before commit");
					inputItemId = setExact(inputItemId, itemId, "Qwen input item identity changed");
				} else {
					if (state !== "response" || responseId === void 0) throw new GuardedVoiceError("invalid-state", "Qwen assistant item arrived before response.created");
					assistantItemId = setExact(assistantItemId, itemId, "Qwen assistant item identity changed");
				}
				return;
			}
			case "response.audio_transcript.delta":
				publishAssistantTranscript(event, false);
				return;
			case "response.audio_transcript.done":
				publishAssistantTranscript(event, true);
				return;
			case "response.audio.delta": {
				assertOutputIdentity(event);
				if (assistantAudioDone) throw new GuardedVoiceError("invalid-state", "Qwen output audio changed after completion");
				const pcm24 = strictBase64(event.delta);
				outputBytes += pcm24.byteLength;
				if (outputBytes > MAX_QWEN_OUTPUT_TURN_BYTES) throw new GuardedVoiceError("invalid-message", "Qwen output audio exceeds the turn limit");
				emit({
					type: "audio",
					pcm24
				});
				return;
			}
			case "response.done": {
				if (responseDone || state !== "response") throw new GuardedVoiceError("invalid-state", "Qwen response completed out of order");
				const response = recordOf(event.response, "Qwen response.done has no response");
				const id = boundedString(response.id, "response id");
				if (responseId === void 0 || responseId !== id) throw new GuardedVoiceError("invalid-state", "Qwen response identity changed");
				if (response.status !== "completed" && response.status !== "cancelled") throw new GuardedVoiceError("invalid-state", "Qwen response did not complete safely");
				if (response.status === "completed") {
					if (response.object !== "realtime.response" || !hasAudioModalities(response.modalities) || !Array.isArray(response.output) || response.output.length !== 1 || !assistantTranscriptFinal || !assistantAudioDone || outputBytes === 0) throw new GuardedVoiceError("invalid-state", "Qwen response completed before final transcript and audio");
					validateOutputItem(response.output[0], true);
				} else {
					if (response.object !== void 0 && response.object !== "realtime.response") throw new GuardedVoiceError("invalid-state", "Qwen cancelled response has an invalid object");
					if (response.modalities !== void 0 && !hasAudioModalities(response.modalities)) throw new GuardedVoiceError("invalid-state", "Qwen cancelled response changed modalities");
					if (response.output !== void 0) {
						if (!Array.isArray(response.output) || response.output.length > 1) throw new GuardedVoiceError("invalid-state", "Qwen cancelled response output is invalid");
						if (response.output.length === 1) validateOutputItem(response.output[0], false);
					}
				}
				responseDone = true;
				state = "done";
				emit({
					type: "done",
					status: response.status
				});
				beginClose("local", void 0, true);
				return;
			}
			case "response.audio.done":
				assertOutputIdentity(event);
				if (assistantAudioDone || outputBytes === 0) throw new GuardedVoiceError("invalid-state", "Qwen output audio completed out of order");
				assistantAudioDone = true;
				return;
			case "error": throw new GuardedVoiceError("invalid-state", "Qwen rejected the manual turn");
			default: throw new GuardedVoiceError("invalid-message", "Qwen realtime event type is not allowed");
		}
	};
	function onMessage(raw, isBinary) {
		if (state === "closing" || state === "closed") return;
		if (isBinary) {
			failProtocol();
			return;
		}
		try {
			const bytes = bytesOf(raw);
			if (state === "opening") {
				const action = handshake.receive(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
				if (action.kind === "send") {
					send(action.payload);
					return;
				}
				if (readyTimer !== void 0) {
					cancelScheduled(readyTimer);
					readyTimer = void 0;
				}
				state = "input";
				phaseTimer = schedule(() => {
					phaseTimer = void 0;
					beginClose("transport-error");
				}, inputTimeoutMs);
				resolveOpened(session);
				return;
			}
			handleReadyEvent(parseEvent(bytes));
		} catch {
			failProtocol();
		}
	}
	function onError() {
		beginClose("transport-error");
	}
	function onClose() {
		beginClose("provider-closed");
	}
	function onAbort() {
		beginClose("transport-error", new GuardedVoiceError("invalid-state", "Qwen realtime session was cancelled"));
	}
	function onCleanupError() {}
	function onCleanupClose() {
		completeClose();
	}
	const session = {
		authorization: {
			provider: "qwen",
			model: options.model
		},
		closed,
		appendPcm16(chunk) {
			if (state !== "input") throw new GuardedVoiceError("invalid-state", "Qwen manual turn is not accepting audio");
			if (chunk.byteLength === 0 || chunk.byteLength > MAX_QWEN_INPUT_CHUNK_BYTES || chunk.byteLength % 2 !== 0) throw new GuardedVoiceError("invalid-message", "PCM16 input chunk is invalid");
			inputBytes += chunk.byteLength;
			if (inputBytes > MAX_QWEN_INPUT_TURN_BYTES) throw new GuardedVoiceError("invalid-message", "PCM16 input exceeds the turn limit");
			try {
				send({
					type: "input_audio_buffer.append",
					audio: Buffer$1.from(chunk).toString("base64")
				});
			} catch (error) {
				beginClose("transport-error");
				throw error;
			}
		},
		commit() {
			if (state !== "input" || inputBytes === 0) throw new GuardedVoiceError("invalid-state", "Qwen manual turn has no audio to commit");
			state = "response";
			if (phaseTimer !== void 0) {
				cancelScheduled(phaseTimer);
				phaseTimer = void 0;
			}
			phaseTimer = schedule(() => {
				phaseTimer = void 0;
				beginClose("transport-error");
			}, responseTimeoutMs);
			try {
				send({ type: "input_audio_buffer.commit" });
				send({
					type: "response.create",
					response: { modalities: ["text", "audio"] }
				});
			} catch (error) {
				beginClose("transport-error");
				throw error;
			}
		},
		close() {
			beginClose("local", void 0, true);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
	};
	if (options.signal.aborted) {
		beginClose("transport-error", new GuardedVoiceError("invalid-state", "Qwen realtime session was cancelled"));
		return opened;
	}
	options.signal.addEventListener("abort", onAbort, { once: true });
	readyTimer = schedule(() => {
		beginClose("transport-error", new GuardedVoiceError("invalid-state", "Qwen realtime session timed out"));
	}, timeoutMs);
	Promise.resolve().then(() => {
		if (state !== "opening" || options.signal.aborted) return void 0;
		return options.resolveCredential(operation.signal);
	}).then((credential) => {
		if (state !== "opening" || options.signal.aborted) return;
		socket = createSocket(endpoint, {
			authorization: authorizationOf(credential),
			handshakeTimeoutMs: timeoutMs,
			maxPayload: MAX_QWEN_REALTIME_EVENT_BYTES
		});
		socket.on("message", onMessage);
		socket.once("error", onError);
		socket.once("close", onClose);
	}).catch((error) => {
		if (state !== "opening") return;
		beginClose("transport-error", error instanceof GuardedVoiceError ? error : new GuardedVoiceError("invalid-state", "Qwen realtime session failed"));
	});
	return opened;
}
//#endregion
//#region src/host/gateway.ts
function textOf(data) {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
	if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
	return data.toString("utf8");
}
function binaryOf(data) {
	if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return new Uint8Array(data);
}
/** Exact-session carrier: bounded binary PCM is admitted only after consent and provider readiness. */
var GuardedVoiceGateway = class {
	options;
	server = new WebSocketServer({
		noServer: true,
		clientTracking: false,
		perMessageDeflate: false,
		maxPayload: Math.max(MAX_CONTROL_BYTES, MAX_QWEN_INPUT_CHUNK_BYTES)
	});
	clients = /* @__PURE__ */ new Map();
	bindTimeoutMs;
	maxConnections;
	constructor(options) {
		this.options = options;
		this.bindTimeoutMs = options.bindTimeoutMs ?? 1e4;
		this.maxConnections = options.maxConnections ?? 8;
		if (!Number.isSafeInteger(this.bindTimeoutMs) || this.bindTimeoutMs < 10 || this.bindTimeoutMs > 6e4) throw new TypeError("bind timeout must be an integer between 10 ms and 60 seconds");
		if (!Number.isSafeInteger(this.maxConnections) || this.maxConnections < 1 || this.maxConnections > 64) throw new TypeError("max connections must be an integer between 1 and 64");
	}
	handleUpgrade(request, socket, head) {
		const assessment = assessUpgradeRequest({
			method: request.method,
			headers: request.headers,
			remoteAddress: request.socket.remoteAddress
		}, this.options.trustedHosts);
		if (!assessment.ok) {
			rejectUpgrade(socket, assessment);
			return;
		}
		if (this.clients.size >= this.maxConnections) {
			rejectUpgrade(socket, {
				ok: false,
				status: 429,
				reason: "DSH Live Voice connection limit reached"
			});
			return;
		}
		this.server.handleUpgrade(request, socket, head, (webSocket) => this.accept(webSocket));
	}
	stopSession(sessionId) {
		const connectionIds = /* @__PURE__ */ new Set([...this.options.turns?.stopSession(sessionId) ?? [], ...this.options.manager.stopSession(sessionId)]);
		for (const connectionId of connectionIds) {
			const client = this.take(connectionId);
			if (client === void 0) continue;
			this.send(client.socket, {
				v: 1,
				type: "error",
				code: "authority-changed",
				message: "the bound session was disposed"
			});
			client.socket.close(1008, "session disposed");
		}
	}
	close() {
		for (const connectionId of [...this.clients.keys()]) {
			const client = this.take(connectionId);
			if (client === void 0) continue;
			this.options.manager.stop(connectionId);
			this.options.turns?.stop(connectionId);
			client.socket.terminate();
		}
		this.server.close();
		this.options.turns?.close();
	}
	/** Number of carrier connections currently consuming the bounded capacity. */
	get connectionCount() {
		return this.clients.size;
	}
	accept(socket) {
		const connectionId = randomUUID();
		const client = {
			socket,
			tail: Promise.resolve(),
			bindTimer: void 0,
			consentTimer: void 0
		};
		client.bindTimer = setTimeout(() => {
			this.fail(connectionId, new GuardedVoiceError("invalid-state", "connection did not bind in time"));
		}, this.bindTimeoutMs);
		this.clients.set(connectionId, client);
		socket.on("message", (data, isBinary) => {
			if (isBinary) {
				const pcm16 = new Uint8Array(binaryOf(data));
				client.tail = client.tail.then(() => {
					if (this.clients.get(connectionId) !== client) return;
					if (this.options.turns === void 0) throw new GuardedVoiceError("invalid-state", "manual audio turns are not configured");
					this.options.turns.appendPcm16(connectionId, pcm16);
				}).catch((error) => {
					this.fail(connectionId, error);
				});
				return;
			}
			let control;
			try {
				control = parseClientControl(textOf(data));
			} catch (error) {
				this.fail(connectionId, error);
				return;
			}
			if (control.type === "stop") {
				this.stopNow(connectionId);
				return;
			}
			client.tail = client.tail.then(() => this.handleControl(connectionId, control)).catch((error) => {
				this.fail(connectionId, error);
			});
		});
		socket.once("close", () => {
			this.remove(connectionId);
		});
		socket.once("error", (error) => {
			this.options.logger?.warn(error);
			this.remove(connectionId);
		});
	}
	async handleControl(connectionId, control) {
		const client = this.clients.get(connectionId);
		if (client === void 0) return;
		if (control.type === "bind") {
			const begun = this.options.manager.begin(connectionId, control.sessionId);
			if (client.bindTimer !== void 0) clearTimeout(client.bindTimer);
			client.bindTimer = void 0;
			client.consentTimer = setTimeout(() => {
				this.fail(connectionId, new GuardedVoiceError("consent-expired", "disclosure acceptance expired"));
			}, Math.max(0, begun.expiresAt - Date.now()));
			this.send(client.socket, {
				v: 1,
				type: "consent.required",
				challenge: begun.challenge,
				expiresAt: begun.expiresAt,
				sessionId: begun.binding.sessionId,
				workspaceId: begun.binding.workspaceId,
				provider: "qwen",
				disclosure: {
					audioDestination: "Alibaba Cloud Qwen realtime API",
					exportedContext: "none",
					executionAuthority: "none",
					providerRetention: "not specified for Qwen realtime audio",
					currentMilestone: "one bounded manual audio turn after acceptance"
				}
			});
			return;
		}
		if (control.type === "turn.commit") {
			if (this.options.turns === void 0) throw new GuardedVoiceError("invalid-state", "manual audio turns are not configured");
			this.options.turns.commit(connectionId);
			return;
		}
		if (client.consentTimer !== void 0) clearTimeout(client.consentTimer);
		client.consentTimer = void 0;
		const ready = await this.options.manager.acceptConsent(connectionId, control.challenge);
		const provider = this.options.turns === void 0 ? ready.provider : await this.options.turns.start(connectionId, {
			event: (event) => {
				const live = this.clients.get(connectionId);
				if (live === void 0) return;
				if (event.type === "transcript") this.send(live.socket, {
					v: 1,
					type: "transcript",
					role: event.role,
					text: event.text,
					final: event.final
				});
				else if (event.type === "audio") {
					if (live.socket.bufferedAmount + event.pcm24.byteLength > MAX_QWEN_BUFFERED_BYTES) this.fail(connectionId, new GuardedVoiceError("invalid-state", "browser audio backpressure limit reached"));
					else if (live.socket.readyState === WebSocket.OPEN) live.socket.send(event.pcm24, { binary: true });
				} else this.send(live.socket, {
					v: 1,
					type: "turn.done",
					status: event.status
				});
			},
			failed: (error) => {
				this.fail(connectionId, error);
			}
		});
		this.send(client.socket, {
			v: 1,
			type: "ready",
			sessionId: ready.binding.sessionId,
			workspaceId: ready.binding.workspaceId,
			provider: provider.provider,
			model: provider.model,
			authority: "proposal-only"
		});
	}
	stopNow(connectionId) {
		const client = this.take(connectionId);
		if (client === void 0) return;
		this.options.manager.stop(connectionId);
		this.options.turns?.stop(connectionId);
		this.send(client.socket, {
			v: 1,
			type: "stopped"
		});
		client.socket.close(1e3, "stopped");
	}
	fail(connectionId, error) {
		const client = this.take(connectionId);
		if (client === void 0) return;
		const safe = asGuardedVoiceError(error);
		this.options.logger?.warn(safe);
		this.send(client.socket, {
			v: 1,
			type: "error",
			code: safe.code,
			message: safe.message
		});
		this.options.manager.stop(connectionId);
		this.options.turns?.stop(connectionId);
		client.socket.close(1008, safe.code);
	}
	send(socket, event) {
		if (socket.readyState === WebSocket.OPEN) socket.send(encodeServerControl(event));
	}
	remove(connectionId) {
		this.take(connectionId);
		this.options.manager.stop(connectionId);
		this.options.turns?.stop(connectionId);
	}
	take(connectionId) {
		const client = this.clients.get(connectionId);
		if (client === void 0) return void 0;
		this.clients.delete(connectionId);
		this.clearTimers(client);
		return client;
	}
	clearTimers(client) {
		if (client.bindTimer !== void 0) clearTimeout(client.bindTimer);
		if (client.consentTimer !== void 0) clearTimeout(client.consentTimer);
		client.bindTimer = void 0;
		client.consentTimer = void 0;
	}
};
//#endregion
//#region src/host/manual-turn.ts
function sameBinding(left, right) {
	return left.sessionId === right.sessionId && left.workspaceId === right.workspaceId;
}
/**
* Binds one provider turn to an already accepted manager connection.
* Revalidation occurs before open, after open, before every audio/commit
* operation, and before every provider event crosses back to the browser, so a
* Session id-reuse or Workspace move cannot inherit either side of the turn.
*/
var ManualTurnCoordinator = class {
	manager;
	openProvider;
	turns = /* @__PURE__ */ new Map();
	constructor(manager, openProvider) {
		this.manager = manager;
		this.openProvider = openProvider;
	}
	async start(connectionId, sink) {
		if (this.turns.has(connectionId)) throw new GuardedVoiceError("invalid-state", "manual turn is already open");
		const ready = this.manager.revalidate(connectionId);
		const opening = {
			phase: "opening",
			binding: ready.binding,
			abortController: new AbortController()
		};
		this.turns.set(connectionId, opening);
		let provider;
		try {
			provider = await this.openProvider(ready.binding, ready.provider, opening.abortController.signal);
			if (this.turns.get(connectionId) !== opening) throw new GuardedVoiceError("invalid-state", "manual turn stopped while opening");
			const current = this.manager.revalidate(connectionId);
			if (!sameBinding(current.binding, opening.binding) || current.provider.provider !== provider.authorization.provider || current.provider.model !== provider.authorization.model) throw new GuardedVoiceError("authority-changed", "manual turn provider binding changed");
			const record = {
				phase: "ready",
				binding: opening.binding,
				session: provider,
				unsubscribe: () => {},
				done: false
			};
			record.unsubscribe = provider.subscribe((event) => {
				if (this.turns.get(connectionId) !== record) return;
				try {
					this.revalidate(connectionId, record);
				} catch (error) {
					sink.failed(asGuardedVoiceError(error));
					return;
				}
				if (event.type === "done") record.done = true;
				sink.event(event);
			});
			this.turns.set(connectionId, record);
			provider.closed.then((reason) => {
				if (this.turns.get(connectionId) !== record) return;
				record.unsubscribe();
				this.turns.delete(connectionId);
				if (reason !== "local" && !record.done) sink.failed(new GuardedVoiceError("invalid-state", "voice provider connection ended"));
			});
			return provider.authorization;
		} catch (error) {
			provider?.close();
			if (this.turns.get(connectionId) === opening) this.turns.delete(connectionId);
			throw error;
		}
	}
	appendPcm16(connectionId, chunk) {
		const current = this.ready(connectionId);
		this.revalidate(connectionId, current);
		current.session.appendPcm16(chunk);
	}
	commit(connectionId) {
		const current = this.ready(connectionId);
		this.revalidate(connectionId, current);
		current.session.commit();
	}
	stop(connectionId) {
		const current = this.turns.get(connectionId);
		if (current === void 0) return false;
		this.turns.delete(connectionId);
		if (current.phase === "opening") current.abortController.abort();
		else {
			current.unsubscribe();
			current.session.close();
		}
		return true;
	}
	stopSession(sessionId) {
		const stopped = [];
		for (const [connectionId, current] of this.turns) {
			if (current.binding.sessionId !== sessionId) continue;
			this.stop(connectionId);
			stopped.push(connectionId);
		}
		return stopped;
	}
	close() {
		for (const connectionId of [...this.turns.keys()]) this.stop(connectionId);
	}
	get size() {
		return this.turns.size;
	}
	ready(connectionId) {
		const current = this.turns.get(connectionId);
		if (current?.phase !== "ready") throw new GuardedVoiceError("invalid-state", "manual turn is not ready");
		return current;
	}
	revalidate(connectionId, current) {
		let latest;
		try {
			latest = this.manager.revalidate(connectionId);
		} catch (error) {
			this.stop(connectionId);
			throw error;
		}
		if (!sameBinding(latest.binding, current.binding)) {
			this.stop(connectionId);
			throw new GuardedVoiceError("authority-changed", "manual turn binding changed");
		}
	}
};
//#endregion
//#region src/host/session-manager.ts
/** Pure lifecycle coordinator: authority -> disclosure acceptance -> provider authorization. */
var VoiceSessionManager = class {
	authority;
	consents;
	authorizeProvider;
	connections = /* @__PURE__ */ new Map();
	constructor(authority, consents, authorizeProvider) {
		this.authority = authority;
		this.consents = consents;
		this.authorizeProvider = authorizeProvider;
	}
	begin(connectionId, sessionId) {
		if (this.connections.has(connectionId)) throw new GuardedVoiceError("invalid-state", "connection is already bound");
		const lease = this.authority.bind(sessionId);
		const subject = this.subject(connectionId, lease.binding);
		const issued = this.consents.issue(subject);
		this.connections.set(connectionId, {
			phase: "awaiting-consent",
			lease,
			challenge: issued.challenge,
			expiresAt: issued.expiresAt
		});
		return {
			binding: lease.binding,
			...issued
		};
	}
	async acceptConsent(connectionId, challenge) {
		const current = this.connections.get(connectionId);
		if (current?.phase !== "awaiting-consent") throw new GuardedVoiceError("consent-required", "connection is not awaiting consent");
		const binding = this.authority.revalidate(current.lease);
		this.consents.consume(challenge, this.subject(connectionId, binding));
		const authorizing = {
			phase: "authorizing",
			lease: current.lease,
			abortController: new AbortController()
		};
		this.connections.set(connectionId, authorizing);
		try {
			const provider = await this.authorizeProvider(binding, authorizing.abortController.signal);
			if (this.connections.get(connectionId) !== authorizing) throw new GuardedVoiceError("invalid-state", "connection stopped during provider authorization");
			this.authority.revalidate(current.lease);
			this.connections.set(connectionId, {
				phase: "ready",
				lease: current.lease,
				provider
			});
			return {
				binding,
				provider
			};
		} catch (error) {
			if (this.connections.get(connectionId) === authorizing) this.connections.delete(connectionId);
			throw error;
		}
	}
	revalidate(connectionId) {
		const current = this.connections.get(connectionId);
		if (current?.phase !== "ready") throw new GuardedVoiceError("consent-required", "connection is not ready");
		return {
			binding: this.authority.revalidate(current.lease),
			provider: current.provider
		};
	}
	stop(connectionId) {
		const current = this.connections.get(connectionId);
		if (current === void 0) return false;
		if (current.phase === "awaiting-consent") this.consents.revoke(current.challenge);
		if (current.phase === "authorizing") current.abortController.abort(new GuardedVoiceError("invalid-state", "provider authorization was cancelled"));
		this.connections.delete(connectionId);
		return true;
	}
	stopSession(sessionId) {
		const stopped = [];
		for (const [connectionId, current] of this.connections) {
			if (current.lease.binding.sessionId !== sessionId) continue;
			this.stop(connectionId);
			stopped.push(connectionId);
		}
		return stopped;
	}
	get size() {
		return this.connections.size;
	}
	subject(connectionId, binding) {
		return {
			connectionId,
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
			provider: "qwen"
		};
	}
};
//#endregion
//#region src/host/proposal.ts
const PROPOSAL_TOOL_NAME = "prepare_work_instruction";
const MAX_PROPOSAL_TITLE_LENGTH = 120;
const MAX_PROPOSAL_INSTRUCTION_LENGTH = 4e3;
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function cleanText(value, field, maxLength) {
	if (typeof value !== "string") throw new GuardedVoiceError("invalid-message", `${field} must be text`);
	const cleaned = value.replace(/\r\n?/gu, "\n").trim();
	if (cleaned.length === 0 || cleaned.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(cleaned)) throw new GuardedVoiceError("invalid-message", `${field} is empty, too long, or contains control characters`);
	return cleaned;
}
/** Normalize one provider tool-call payload into a non-executable proposal. */
function parseGuardedProposal(rawArguments, target) {
	if (new TextEncoder().encode(rawArguments).byteLength > 8192) throw new GuardedVoiceError("invalid-message", "proposal arguments exceed the byte limit");
	let parsed;
	try {
		parsed = JSON.parse(rawArguments);
	} catch {
		throw new GuardedVoiceError("invalid-message", "proposal arguments are not valid JSON");
	}
	if (!isRecord(parsed)) throw new GuardedVoiceError("invalid-message", "proposal arguments must be an object");
	const allowed = /* @__PURE__ */ new Set(["title", "instruction"]);
	if (Object.keys(parsed).some((key) => !allowed.has(key))) throw new GuardedVoiceError("invalid-message", "proposal arguments contain unsupported fields");
	const instruction = cleanText(parsed.instruction, "instruction", MAX_PROPOSAL_INSTRUCTION_LENGTH);
	const title = parsed.title === void 0 ? void 0 : cleanText(parsed.title, "title", 120);
	return {
		kind: "work-instruction",
		...title === void 0 ? {} : { title },
		instruction,
		target: { ...target },
		authority: "none"
	};
}
//#endregion
//#region src/index.ts
const Config = z.object({
	credentialRef: z.string().default("DASHSCOPE_API_KEY"),
	route: z.string().default("/guarded-voice"),
	model: z.string().default(DEFAULT_QWEN_REALTIME_MODEL),
	dashscopeWorkspaceId: z.string(),
	trustedHosts: z.string().default("localhost,127.0.0.1,[::1]"),
	consentTtlMs: z.natural().min(1e3).max(3e5).default(6e4),
	maxConnections: z.natural().min(1).max(64).default(8)
});
const inject = [
	"credentials",
	"sessions",
	"workspaceRegistry",
	"webServer",
	"connection"
];
function harnessConnectionRejection(ctx, request) {
	const connection = ctx.connection;
	const gate = connection?.requestRejection;
	if (gate === void 0) return void 0;
	if (typeof gate !== "function") throw new TypeError("DSH connection requestRejection must be a function");
	const rejection = gate.call(connection, request);
	if (rejection === void 0 || rejection === 401 || rejection === 403) return rejection;
	throw new TypeError("DSH connection requestRejection returned an invalid status");
}
function resolvedConfig(config = {}) {
	return {
		credentialRef: config.credentialRef ?? "DASHSCOPE_API_KEY",
		route: config.route ?? "/guarded-voice",
		model: config.model ?? "qwen-audio-3.0-realtime-plus",
		trustedHosts: config.trustedHosts ?? "localhost,127.0.0.1,[::1]",
		consentTtlMs: config.consentTtlMs ?? 6e4,
		maxConnections: config.maxConnections ?? 8,
		...config.dashscopeWorkspaceId === void 0 ? {} : { dashscopeWorkspaceId: config.dashscopeWorkspaceId }
	};
}
function parseTrustedHosts(value) {
	const hosts = value.split(",").map((entry) => entry.trim()).filter(Boolean);
	assertTrustedHosts(hosts);
	return hosts;
}
function assertRoute(route) {
	parseGuardedVoiceClientBoot({
		v: 1,
		route
	});
}
/** Register the exact-session disclosure carrier and one bounded manual provider turn. */
function apply(ctx, input) {
	const config = resolvedConfig(input);
	assertRoute(config.route);
	const trustedHosts = parseTrustedHosts(config.trustedHosts);
	const ref = credentialRef(config.credentialRef);
	if (!isQwenRealtimeModel(config.model)) throw new TypeError(`unsupported Qwen realtime model: ${config.model}`);
	const model = config.model;
	const manager = new VoiceSessionManager(new AuthorityGuard({ get: (sessionId) => ctx.sessions.get(SessionId(sessionId)) }, { list: () => ctx.workspaceRegistry.list() }), new ConsentChallenges({ ttlMs: config.consentTtlMs }), async (_binding, signal) => {
		signal.throwIfAborted();
		if (config.dashscopeWorkspaceId === void 0) throw new GuardedVoiceError("provider-unconfigured", "DashScope workspace id is not configured");
		buildQwenRealtimeEndpoint(config.dashscopeWorkspaceId, model);
		const resolved = await ctx.credentials.resolve(ref);
		signal.throwIfAborted();
		if (resolved === void 0) throw new GuardedVoiceError("provider-unconfigured", "DashScope credential is not configured");
		return {
			provider: "qwen",
			model
		};
	});
	const gateway = new GuardedVoiceGateway({
		manager,
		turns: new ManualTurnCoordinator(manager, async (_binding, authorization, signal) => {
			signal.throwIfAborted();
			if (authorization.provider !== "qwen" || authorization.model !== model) throw new GuardedVoiceError("provider-unconfigured", "provider authorization does not match Qwen configuration");
			if (config.dashscopeWorkspaceId === void 0) throw new GuardedVoiceError("provider-unconfigured", "DashScope workspace id is not configured");
			return openQwenManualTurn({
				workspaceId: config.dashscopeWorkspaceId,
				model,
				signal,
				resolveCredential: async (credentialSignal) => {
					credentialSignal.throwIfAborted();
					const resolved = await ctx.credentials.resolve(ref);
					credentialSignal.throwIfAborted();
					return resolved?.value;
				}
			});
		}),
		trustedHosts,
		maxConnections: config.maxConnections,
		logger: { warn: (error) => {
			ctx.logger.warn(error);
		} }
	});
	ctx.on("webserver/index-inject", (table) => {
		table.push(guardedVoiceClientBootInjection(config.route));
	});
	ctx.effect(() => ctx.webServer.registerUpgrade({
		path: config.route,
		handler: (request, socket, head) => {
			const rejection = harnessConnectionRejection(ctx, request);
			if (rejection !== void 0) {
				rejectConnectionUpgrade(socket, rejection);
				return;
			}
			gateway.handleUpgrade(request, socket, head);
		}
	}), `dsh-live-voice: ${config.route} upgrade`);
	ctx.effect(() => () => {
		gateway.close();
	}, "dsh-live-voice: gateway cleanup");
	ctx.on("session/disposed", (session) => {
		gateway.stopSession(String(session.id));
	});
}
//#endregion
export { AuthorityGuard, CLIENT_BOOT_GLOBAL, CLIENT_BOOT_VERSION, Config, ConsentChallenges, DEFAULT_QWEN_INPUT_TIMEOUT_MS, DEFAULT_QWEN_REALTIME_MODEL, DEFAULT_QWEN_RESPONSE_TIMEOUT_MS, GuardedVoiceError, MAX_CONTROL_BYTES, MAX_PROPOSAL_INSTRUCTION_LENGTH, MAX_PROPOSAL_TITLE_LENGTH, MAX_QWEN_BUFFERED_BYTES, MAX_QWEN_INPUT_CHUNK_BYTES, MAX_QWEN_INPUT_TURN_BYTES, MAX_QWEN_OUTPUT_CHUNK_BYTES, MAX_QWEN_OUTPUT_TURN_BYTES, MAX_QWEN_PHASE_TIMEOUT_MS, MAX_QWEN_PROVIDER_CONTROL_BYTES, MAX_QWEN_REALTIME_EVENT_BYTES, MAX_QWEN_TRANSCRIPT_LENGTH, ManualTurnCoordinator, PROPOSAL_TOOL_NAME, QWEN_REALTIME_MODELS, QwenHandshake, VoiceSessionManager, WIRE_VERSION, apply, assertTrustedHosts, assessUpgradeRequest, buildQwenRealtimeEndpoint, encodeServerControl, guardedVoiceClientBootInjection, inject, isQwenRealtimeModel, openQwenManualTurn, parseClientControl, parseGuardedProposal, parseGuardedVoiceClientBoot, parseServerControl };
