window.__ModuleLoader__.load({
	id: "dsh-live-voice",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/shared/boot.ts
		const CLIENT_BOOT_GLOBAL = "__DSH_GUARDED_LIVE_VOICE__";
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
		//#region src/shared/audio.ts
		/** PCM16 mono input expected by Qwen realtime. */
		const INPUT_PCM_SAMPLE_RATE = 16e3;
		/** PCM16 mono output produced by Qwen realtime. */
		const OUTPUT_PCM_SAMPLE_RATE = 24e3;
		const MAX_VOICE_TRANSCRIPT_LENGTH = 4096;
		//#endregion
		//#region src/client/audio-capture.ts
		const WORKLET_NAME = "dsh-guarded-live-voice-capture-v1";
		const WORKLET_SOURCE = `
class GuardedLiveVoiceCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0]
    if (channels && channels.length > 0 && channels[0].length > 0) {
      const mono = new Float32Array(channels[0].length)
      for (const channel of channels) {
        for (let index = 0; index < mono.length; index += 1) {
          mono[index] += channel[index] / channels.length
        }
      }
      this.port.postMessage(mono, [mono.buffer])
    }
    return true
  }
}
registerProcessor('${WORKLET_NAME}', GuardedLiveVoiceCapture)
`;
		/**
		* Stateful linear resampling preserves phase across browser audio callbacks.
		* The encoder accepts channel planes, downmixes them, and emits little-endian
		* mono PCM16 at the requested target rate.
		*/
		var StreamingPcm16Encoder = class {
			sourceRate;
			targetRate;
			pending = /* @__PURE__ */ new Float32Array(0);
			position = 0;
			inputSamples = 0;
			outputSamples = 0;
			constructor(sourceRate, targetRate = INPUT_PCM_SAMPLE_RATE) {
				this.sourceRate = sourceRate;
				this.targetRate = targetRate;
				if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) throw new TypeError("audio sample rates must be positive finite numbers");
			}
			push(channels) {
				if (channels.length === 0) return /* @__PURE__ */ new Uint8Array(0);
				const frameCount = channels[0]?.length ?? 0;
				if (frameCount === 0) return /* @__PURE__ */ new Uint8Array(0);
				for (const channel of channels) if (channel.length !== frameCount) throw new TypeError("audio channel lengths must match");
				this.inputSamples += frameCount;
				const mono = new Float32Array(frameCount);
				for (const channel of channels) for (let index = 0; index < frameCount; index += 1) mono[index] = (mono[index] ?? 0) + (channel[index] ?? 0) / channels.length;
				const joined = new Float32Array(this.pending.length + mono.length);
				joined.set(this.pending);
				joined.set(mono, this.pending.length);
				const ratio = this.sourceRate / this.targetRate;
				const output = [];
				while (this.position + 1 < joined.length) {
					const leftIndex = Math.floor(this.position);
					const fraction = this.position - leftIndex;
					const left = joined[leftIndex] ?? 0;
					const right = joined[leftIndex + 1] ?? left;
					output.push(left + (right - left) * fraction);
					this.position += ratio;
				}
				const consumed = Math.min(Math.floor(this.position), joined.length);
				this.pending = joined.slice(consumed);
				this.position -= consumed;
				this.outputSamples += output.length;
				return encodePcm16(output);
			}
			/** Flush the final sample without manufacturing an unbounded tail. */
			finish() {
				if (this.pending.length === 0 || this.position >= this.pending.length) {
					this.pending = /* @__PURE__ */ new Float32Array(0);
					this.position = 0;
					this.inputSamples = 0;
					this.outputSamples = 0;
					return /* @__PURE__ */ new Uint8Array(0);
				}
				const ratio = this.sourceRate / this.targetRate;
				const output = [];
				const targetSamples = Math.ceil(this.inputSamples * this.targetRate / this.sourceRate);
				const remainingSamples = Math.max(0, targetSamples - this.outputSamples);
				const last = this.pending[this.pending.length - 1] ?? 0;
				while (this.position < this.pending.length && output.length < remainingSamples) {
					const leftIndex = Math.floor(this.position);
					const fraction = this.position - leftIndex;
					const left = this.pending[leftIndex] ?? last;
					const right = this.pending[leftIndex + 1] ?? last;
					output.push(left + (right - left) * fraction);
					this.position += ratio;
				}
				this.pending = /* @__PURE__ */ new Float32Array(0);
				this.position = 0;
				this.inputSamples = 0;
				this.outputSamples = 0;
				return encodePcm16(output);
			}
		};
		/** Browser microphone capture with bounded PCM framing and owned cleanup. */
		var BrowserPcmCapture = class {
			options;
			frameBytes;
			maxTurnBytes;
			mediaDevices;
			createAudioContext;
			createProcessor;
			generation = 0;
			resources;
			pending;
			encoder;
			frame = /* @__PURE__ */ new Uint8Array(0);
			frameLength = 0;
			acceptedBytes = 0;
			limitReached = false;
			constructor(options) {
				this.options = options;
				this.frameBytes = options.frameBytes ?? 3200;
				this.maxTurnBytes = options.maxTurnBytes ?? 96e4;
				if (!Number.isSafeInteger(this.frameBytes) || this.frameBytes <= 0 || this.frameBytes > 32768 || this.frameBytes % 2 !== 0) throw new TypeError("capture frame size exceeds the PCM16 chunk boundary");
				if (!Number.isSafeInteger(this.maxTurnBytes) || this.maxTurnBytes <= 0 || this.maxTurnBytes > 96e4 || this.maxTurnBytes % 2 !== 0) throw new TypeError("capture turn size exceeds the PCM16 turn boundary");
				this.mediaDevices = options.mediaDevices ?? browserMediaDevices();
				this.createAudioContext = options.createAudioContext ?? browserAudioContext$1;
				this.createProcessor = options.createProcessor ?? createAudioWorkletProcessor;
			}
			async start() {
				if (this.resources !== void 0 || this.pending !== void 0) return;
				const generation = ++this.generation;
				this.frame = new Uint8Array(this.frameBytes);
				this.frameLength = 0;
				this.acceptedBytes = 0;
				this.limitReached = false;
				let pending;
				let processor;
				try {
					const context = this.createAudioContext();
					const staged = {
						generation,
						context,
						stream: void 0,
						source: void 0
					};
					pending = staged;
					this.pending = staged;
					const resume = context.state === "suspended" ? context.resume() : Promise.resolve();
					const media = this.mediaDevices.getUserMedia({
						audio: {
							channelCount: 1,
							echoCancellation: true,
							noiseSuppression: true,
							autoGainControl: true
						},
						video: false
					}).then((stream) => {
						if (this.pending !== staged || generation !== this.generation) stopTracks(stream);
						else staged.stream = stream;
						return stream;
					});
					const [stream] = await Promise.all([media, resume.then(() => void 0)]);
					if (this.pending !== staged || generation !== this.generation) {
						await releasePendingCapture(staged);
						return;
					}
					const source = context.createMediaStreamSource(stream);
					staged.source = source;
					processor = await this.createProcessor(context, (channels) => {
						this.process(channels);
					}, () => {
						this.stop(false);
						this.options.onError(/* @__PURE__ */ new Error("microphone audio processing failed"));
					});
					if (this.pending !== staged || generation !== this.generation) {
						processor.dispose();
						await releasePendingCapture(staged);
						return;
					}
					source.connect(processor.node);
					this.encoder = new StreamingPcm16Encoder(context.sampleRate);
					this.resources = {
						context,
						stream,
						source,
						processor
					};
					staged.stream = void 0;
					staged.source = void 0;
					this.pending = void 0;
				} catch (error) {
					processor?.dispose();
					if (this.pending === pending) this.pending = void 0;
					const isCurrent = generation === this.generation;
					if (isCurrent) {
						++this.generation;
						this.resources = void 0;
						this.encoder = void 0;
					}
					if (pending !== void 0) await releasePendingCapture(pending);
					if (!isCurrent) return;
					throw captureStartError(error);
				}
			}
			stop(flush = true) {
				++this.generation;
				let flushError;
				try {
					const encoder = this.encoder;
					if (flush && encoder !== void 0 && !this.limitReached) {
						this.enqueue(encoder.finish());
						this.flushFrame();
					}
				} catch (error) {
					flushError = error;
				} finally {
					this.encoder = void 0;
					const resources = this.resources;
					this.resources = void 0;
					if (resources !== void 0) releaseResources(resources);
					const pending = this.pending;
					this.pending = void 0;
					if (pending !== void 0 && pending.context !== resources?.context) releasePendingCapture(pending);
				}
				if (flushError !== void 0) throw new Error("microphone audio processing failed");
			}
			process(channels) {
				const encoder = this.encoder;
				if (encoder === void 0 || this.resources === void 0) return;
				try {
					this.enqueue(encoder.push(channels));
				} catch {
					this.stop(false);
					this.options.onError(/* @__PURE__ */ new Error("microphone audio processing failed"));
				}
			}
			enqueue(bytes) {
				let offset = 0;
				while (offset < bytes.byteLength && !this.limitReached) {
					const remainingTurnBytes = this.maxTurnBytes - this.acceptedBytes;
					if (remainingTurnBytes <= 0) {
						this.reachLimit();
						return;
					}
					const writable = Math.min(bytes.byteLength - offset, this.frameBytes - this.frameLength, remainingTurnBytes);
					this.frame.set(bytes.subarray(offset, offset + writable), this.frameLength);
					this.frameLength += writable;
					this.acceptedBytes += writable;
					offset += writable;
					if (this.frameLength === this.frameBytes) this.flushFrame();
					if (this.acceptedBytes === this.maxTurnBytes) this.reachLimit();
				}
			}
			flushFrame() {
				if (this.frameLength === 0) return;
				const owned = this.frame.slice(0, this.frameLength);
				this.frameLength = 0;
				this.options.onChunk(owned);
			}
			reachLimit() {
				if (this.limitReached) return;
				this.limitReached = true;
				this.flushFrame();
				this.stop(false);
				this.options.onLimit();
			}
		};
		function encodePcm16(samples) {
			const bytes = new Uint8Array(samples.length * 2);
			const view = new DataView(bytes.buffer);
			for (let index = 0; index < samples.length; index += 1) {
				const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
				const pcm = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
				view.setInt16(index * 2, pcm, true);
			}
			return bytes;
		}
		function browserMediaDevices() {
			const mediaDevices = globalThis.navigator?.mediaDevices;
			if (mediaDevices === void 0 || typeof mediaDevices.getUserMedia !== "function") return { getUserMedia: () => Promise.reject(/* @__PURE__ */ new Error("microphone capture is unavailable in this browser")) };
			return mediaDevices;
		}
		function browserAudioContext$1() {
			const AudioContextConstructor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
			if (AudioContextConstructor === void 0) throw new Error("browser audio is unavailable");
			return new AudioContextConstructor();
		}
		async function createAudioWorkletProcessor(context, onSamples, onError) {
			if (context.audioWorklet === void 0 || typeof globalThis.AudioWorkletNode !== "function") throw new Error("browser audio worklets are unavailable");
			const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
			try {
				await context.audioWorklet.addModule(moduleUrl);
			} finally {
				URL.revokeObjectURL(moduleUrl);
			}
			const node = new AudioWorkletNode(context, WORKLET_NAME, {
				numberOfInputs: 1,
				numberOfOutputs: 0,
				channelCount: 1,
				channelCountMode: "explicit"
			});
			node.port.onmessage = (event) => {
				if (event.data instanceof Float32Array) onSamples([event.data]);
				else onError();
			};
			node.port.onmessageerror = onError;
			node.onprocessorerror = onError;
			return {
				node,
				dispose() {
					node.port.onmessage = null;
					node.port.onmessageerror = null;
					node.onprocessorerror = null;
					try {
						node.port.close();
					} catch {}
					try {
						node.disconnect();
					} catch {}
				}
			};
		}
		function captureStartError(error) {
			const name = typeof error === "object" && error !== null && "name" in error ? String(error.name) : "";
			if (name === "NotAllowedError" || name === "SecurityError") return /* @__PURE__ */ new Error("microphone permission was denied");
			if (name === "NotFoundError" || name === "DevicesNotFoundError") return /* @__PURE__ */ new Error("no microphone is available");
			if (error instanceof Error && (error.message === "microphone capture is unavailable in this browser" || error.message === "browser audio is unavailable")) return error;
			return /* @__PURE__ */ new Error("microphone capture could not start");
		}
		function stopTracks(stream) {
			for (const track of stream.getTracks()) try {
				track.stop();
			} catch {}
		}
		function releaseResources(resources) {
			try {
				resources.source.disconnect();
			} catch {}
			resources.processor.dispose();
			stopTracks(resources.stream);
			closeContext$1(resources.context);
		}
		async function releasePendingCapture(pending) {
			const source = pending.source;
			pending.source = void 0;
			try {
				source?.disconnect();
			} catch {}
			const stream = pending.stream;
			pending.stream = void 0;
			if (stream !== void 0) stopTracks(stream);
			await closeContext$1(pending.context);
		}
		async function closeContext$1(context) {
			if (context.state === "closed") return;
			try {
				await context.close();
			} catch {}
		}
		//#endregion
		//#region src/client/audio-playback.ts
		/** Ordered, bounded PCM16 playback. It creates audio only from a user gesture. */
		var BrowserPcmPlaybackSink = class {
			createAudioContext;
			maxQueueSeconds;
			maxQueueSources;
			context;
			nextStartAt = 0;
			generation = 0;
			sources = /* @__PURE__ */ new Set();
			constructor(options = {}) {
				this.createAudioContext = options.createAudioContext ?? browserAudioContext;
				this.maxQueueSeconds = options.maxQueueSeconds ?? 5;
				this.maxQueueSources = options.maxQueueSources ?? 256;
				if (!Number.isFinite(this.maxQueueSeconds) || this.maxQueueSeconds <= 0) throw new TypeError("playback queue boundary must be positive");
				if (!Number.isSafeInteger(this.maxQueueSources) || this.maxQueueSources <= 0) throw new TypeError("playback source boundary must be a positive safe integer");
			}
			async prepare() {
				if (this.context !== void 0) {
					if (this.context.state === "suspended") await this.resume(this.context);
					return;
				}
				const generation = this.generation;
				let context;
				try {
					context = this.createAudioContext();
				} catch {
					throw new Error("audio playback could not start");
				}
				try {
					this.context = context;
					this.nextStartAt = context.currentTime;
					if (context.state === "suspended") await context.resume();
				} catch {
					if (this.context === context) this.context = void 0;
					closeContext(context);
					throw new Error("audio playback could not start");
				}
				if (generation !== this.generation || this.context !== context) {
					if (this.context === context) this.context = void 0;
					closeContext(context);
				}
			}
			write(pcm24) {
				const context = this.context;
				if (context === void 0 || context.state === "closed") throw new Error("audio playback was not prepared by a user gesture");
				if (pcm24.byteLength === 0 || pcm24.byteLength > 65536 || pcm24.byteLength % 2 !== 0) throw new Error("audio playback received invalid PCM16 output");
				const frameCount = pcm24.byteLength / 2;
				const duration = frameCount / OUTPUT_PCM_SAMPLE_RATE;
				const startsAt = Math.max(context.currentTime, this.nextStartAt);
				if (this.sources.size >= this.maxQueueSources || startsAt + duration - context.currentTime > this.maxQueueSeconds) throw new Error("audio playback backpressure limit reached");
				const samples = new Float32Array(frameCount);
				const view = new DataView(pcm24.buffer, pcm24.byteOffset, pcm24.byteLength);
				for (let index = 0; index < frameCount; index += 1) {
					const pcm = view.getInt16(index * 2, true);
					samples[index] = pcm < 0 ? pcm / 32768 : pcm / 32767;
				}
				let source;
				try {
					const buffer = context.createBuffer(1, frameCount, OUTPUT_PCM_SAMPLE_RATE);
					buffer.copyToChannel(samples, 0);
					source = context.createBufferSource();
					const generation = this.generation;
					source.buffer = buffer;
					source.connect(context.destination);
					source.onended = () => {
						if (generation === this.generation && source !== void 0) this.sources.delete(source);
						try {
							source?.disconnect();
						} catch {}
					};
					source.start(startsAt);
				} catch {
					if (source !== void 0) source.onended = null;
					try {
						source?.disconnect();
					} catch {}
					throw new Error("audio playback scheduling failed");
				}
				this.sources.add(source);
				this.nextStartAt = startsAt + duration;
			}
			reset() {
				++this.generation;
				for (const source of this.sources) {
					source.onended = null;
					try {
						source.stop();
					} catch {}
					try {
						source.disconnect();
					} catch {}
				}
				this.sources.clear();
				this.nextStartAt = 0;
				const context = this.context;
				this.context = void 0;
				if (context !== void 0) closeContext(context);
			}
			async resume(context) {
				try {
					await context.resume();
				} catch {
					throw new Error("audio playback could not start");
				}
			}
		};
		function browserAudioContext() {
			const AudioContextConstructor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
			if (AudioContextConstructor === void 0) throw new Error("browser audio is unavailable");
			return new AudioContextConstructor();
		}
		async function closeContext(context) {
			if (context.state === "closed") return;
			try {
				await context.close();
			} catch {}
		}
		//#endregion
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
		const MAX_TRANSCRIPT_LENGTH = MAX_VOICE_TRANSCRIPT_LENGTH;
		const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
		function isRecord(value) {
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
			if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.type !== "string") throw new GuardedVoiceError("invalid-message", "server control frame has an unsupported shape or version");
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
				]) || typeof parsed.challenge !== "string" || !CHALLENGE_PATTERN.test(parsed.challenge) || typeof parsed.expiresAt !== "number" || !Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt <= 0 || !isValidWireId(parsed.sessionId) || !isValidWireId(parsed.workspaceId) || parsed.provider !== "qwen" || !isRecord(parsed.disclosure) || !hasOnlyKeys(parsed.disclosure, [
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
		//#region src/client/controller.ts
		const IDLE = { phase: "idle" };
		const SOCKET_CONNECTING = 0;
		const SOCKET_OPEN = 1;
		const CLIENT_FAILURE_CLOSE_CODE = 4e3;
		/** Browser-side disclosure, bounded capture, and one-turn playback coordinator. */
		var VoiceClientController = class {
			options;
			snapshot = IDLE;
			listeners = /* @__PURE__ */ new Set();
			location;
			route;
			socketFactory;
			now;
			schedule;
			cancelScheduled;
			active;
			challenge;
			consentTimer;
			generation = 0;
			disposed = false;
			audioSink;
			captureFactory;
			capture;
			inputBytes = 0;
			outputBytes = 0;
			composerBinding;
			constructor(options) {
				this.options = options;
				this.location = options.location ?? window.location;
				this.route = parseGuardedVoiceClientBoot({
					v: 1,
					route: options.route
				}).route;
				if (this.location.protocol !== "http:" && this.location.protocol !== "https:") throw new TypeError("DSH Live Voice requires an HTTP(S) page");
				this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
				this.now = options.now ?? Date.now;
				this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
				this.cancelScheduled = options.cancelScheduled ?? ((timer) => {
					clearTimeout(timer);
				});
				this.audioSink = options.audioSink ?? {
					prepare: () => Promise.resolve(),
					write: () => {},
					reset: () => {}
				};
				this.captureFactory = options.captureFactory;
			}
			/** Return the identity-stable view until one lifecycle fact changes. */
			getSnapshot = () => this.snapshot;
			/** Subscribe to browser-visible lifecycle changes. */
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			/** Begin exact-session setup; only the later accept call can authorize the provider. */
			start(sessionId) {
				if (this.disposed) return;
				this.releaseActive(1e3, "replaced");
				this.resetTurn();
				const generation = ++this.generation;
				let socket;
				try {
					socket = this.socketFactory(this.socketUrl().toString());
				} catch (error) {
					this.fail(sessionId, error);
					return;
				}
				const active = {
					socket,
					generation,
					sessionId,
					onOpen: () => {
						this.opened(active);
					},
					onMessage: (event) => {
						this.received(active, event);
					},
					onError: () => {
						this.failedSocket(active, "voice websocket failed");
					},
					onClose: (event) => {
						this.closed(active, event);
					}
				};
				this.active = active;
				socket.binaryType = "arraybuffer";
				socket.addEventListener("open", active.onOpen);
				socket.addEventListener("message", active.onMessage);
				socket.addEventListener("error", active.onError);
				socket.addEventListener("close", active.onClose);
				this.publish({
					phase: "connecting",
					sessionId
				});
			}
			/** Append one bounded PCM16 mono/16 kHz chunk to this exact ready Session. */
			appendPcm16(sessionId, chunk) {
				const active = this.active;
				if (this.disposed || this.snapshot.phase !== "ready" || this.snapshot.sessionId !== sessionId || active?.sessionId !== sessionId) return;
				this.relayPcm16(active, chunk);
			}
			/** Start microphone capture only from the exact ready Session's user gesture. */
			beginCapture(sessionId) {
				const active = this.active;
				if (this.disposed || this.snapshot.phase !== "ready" || this.snapshot.sessionId !== sessionId || active?.sessionId !== sessionId || active.socket.readyState !== SOCKET_OPEN) return;
				if (this.captureFactory === void 0) {
					this.failedSocket(active, /* @__PURE__ */ new Error("browser microphone capture is unavailable"));
					return;
				}
				let record;
				let capture;
				try {
					capture = this.captureFactory({
						onChunk: (chunk) => {
							if (record !== void 0) this.capturedPcm16(record, chunk);
						},
						onLimit: () => {
							if (record !== void 0) this.captureLimit(record);
						},
						onError: (error) => {
							if (record !== void 0) this.captureError(record, error);
						}
					});
				} catch (error) {
					this.failedSocket(active, error);
					return;
				}
				record = {
					capture,
					generation: this.generation,
					sessionId
				};
				this.capture = record;
				this.publish({
					...this.snapshot,
					phase: "preparing-audio"
				});
				if (!this.isCaptureActive(active, record) || this.getSnapshot().phase !== "preparing-audio") return;
				this.prepareCapture(active, record);
			}
			/** Finish the explicit microphone turn and ask only the provider for an answer. */
			finishCapture(sessionId) {
				const active = this.active;
				const record = this.capture;
				if (this.disposed || this.snapshot.phase !== "recording" || this.snapshot.sessionId !== sessionId || active?.sessionId !== sessionId || record?.sessionId !== sessionId || record.generation !== this.generation) return;
				try {
					record.capture.stop(true);
				} catch (error) {
					this.failedSocket(active, error);
					return;
				}
				if (this.capture === record) this.capture = void 0;
				if (!this.isActive(active)) return;
				this.commitActiveTurn(active, ["recording"]);
			}
			relayPcm16(active, chunk) {
				if (active.socket.readyState !== SOCKET_OPEN) return;
				if (chunk.byteLength === 0 || chunk.byteLength > 32768 || chunk.byteLength % 2 !== 0 || this.inputBytes + chunk.byteLength > 96e4) {
					this.failedSocket(active, /* @__PURE__ */ new Error("PCM16 input exceeds the manual-turn boundary"));
					return;
				}
				if (active.socket.bufferedAmount + chunk.byteLength > 524288) {
					this.failedSocket(active, /* @__PURE__ */ new Error("voice websocket backpressure limit reached"));
					return;
				}
				try {
					const owned = new Uint8Array(chunk);
					active.socket.send(owned);
					this.inputBytes += owned.byteLength;
				} catch (error) {
					this.failedSocket(active, error);
				}
			}
			/** Commit the one manual turn. This operation can never submit the DSH composer. */
			commitTurn(sessionId) {
				const active = this.active;
				if (this.disposed || this.snapshot.phase !== "ready" || this.snapshot.sessionId !== sessionId || active?.sessionId !== sessionId || active.socket.readyState !== SOCKET_OPEN || this.inputBytes === 0) return;
				this.commitActiveTurn(active, ["ready"]);
			}
			commitActiveTurn(active, allowedPhases) {
				if (!this.isActive(active) || !allowedPhases.includes(this.snapshot.phase) || this.inputBytes === 0) return;
				try {
					const commit = JSON.stringify({
						v: 1,
						type: "turn.commit"
					});
					if (active.socket.bufferedAmount + commit.length > 524288) throw new Error("voice websocket backpressure limit reached");
					active.socket.send(commit);
				} catch (error) {
					this.failedSocket(active, error);
					return;
				}
				this.publish({
					...this.snapshot,
					phase: "responding",
					userTranscript: "",
					assistantTranscript: "",
					userTranscriptFinal: false,
					assistantTranscriptFinal: false
				});
			}
			/** Consume the hidden one-shot challenge after the visible acceptance gesture. */
			accept(sessionId, draftRevision, composerIdentity) {
				if (this.disposed || this.snapshot.phase !== "awaiting-consent" || this.snapshot.sessionId !== sessionId || this.challenge === void 0 || this.active?.sessionId !== sessionId || this.active.socket.readyState !== SOCKET_OPEN) return;
				const disclosure = this.snapshot.disclosure;
				const active = this.active;
				if (disclosure === void 0 || this.now() >= disclosure.expiresAt) {
					if (active !== void 0) this.failedSocket(active, /* @__PURE__ */ new Error("disclosure acceptance expired"));
					return;
				}
				const challenge = this.challenge;
				this.challenge = void 0;
				this.clearConsentTimer();
				try {
					active.socket.send(JSON.stringify({
						v: 1,
						type: "consent.accept",
						challenge
					}));
				} catch (error) {
					this.failedSocket(active, error);
					return;
				}
				this.composerBinding = composerIdentity === void 0 ? void 0 : {
					sessionId,
					identity: composerIdentity
				};
				this.publish({
					phase: "authorizing",
					sessionId,
					disclosure,
					...draftRevision !== void 0 && Number.isSafeInteger(draftRevision) && draftRevision >= 0 ? { draftRevision } : {}
				});
			}
			/** Whether this lifecycle still owns the exact per-Session composer action face accepted by the user. */
			isComposerBindingCurrent(sessionId, composerIdentity) {
				const binding = this.composerBinding;
				return !this.disposed && this.snapshot.sessionId === sessionId && binding?.sessionId === sessionId && binding.identity === composerIdentity;
			}
			/** Atomically consume the exact composer binding before one explicit draft handoff. */
			claimDraftHandoff(sessionId, composerIdentity, draftRevision) {
				const current = this.snapshot;
				if (!this.isComposerBindingCurrent(sessionId, composerIdentity) || current.phase !== "completed" || current.turnStatus !== "completed" || current.userTranscriptFinal !== true || current.userTranscript === void 0 || current.userTranscript.trim() === "" || current.draftRevision !== draftRevision) return false;
				this.composerBinding = void 0;
				return true;
			}
			/** Stop only the addressed setup; a different mounted Session cannot cancel it. */
			stop(sessionId) {
				if (sessionId !== void 0 && this.snapshot.sessionId !== sessionId) return;
				const active = this.active;
				if (active?.socket.readyState === SOCKET_OPEN) try {
					active.socket.send(JSON.stringify({
						v: 1,
						type: "stop"
					}));
				} catch {}
				++this.generation;
				this.releaseActive(1e3, "stopped");
				this.resetTurn();
				this.publish(IDLE);
			}
			/** Release all browser resources and ignore every late socket callback. */
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				++this.generation;
				this.releaseActive(1e3, "plugin disposed");
				this.resetTurn();
				this.snapshot = IDLE;
				this.listeners.clear();
			}
			socketUrl() {
				const url = new URL(this.route, this.location.href);
				url.protocol = this.location.protocol === "https:" ? "wss:" : "ws:";
				url.username = "";
				url.password = "";
				return url;
			}
			opened(active) {
				if (!this.isActive(active) || this.snapshot.phase !== "connecting") return;
				try {
					active.socket.send(JSON.stringify({
						v: 1,
						type: "bind",
						sessionId: active.sessionId
					}));
				} catch (error) {
					this.failedSocket(active, error);
				}
			}
			received(active, message) {
				if (!this.isActive(active)) return;
				if (typeof message.data !== "string") {
					if (this.snapshot.phase !== "responding" || !(message.data instanceof ArrayBuffer)) {
						this.failedSocket(active, "voice websocket sent audio outside the active response");
						return;
					}
					const pcm24 = new Uint8Array(message.data);
					if (pcm24.byteLength === 0 || pcm24.byteLength > 65536 || pcm24.byteLength % 2 !== 0 || this.outputBytes + pcm24.byteLength > 288e4) {
						this.failedSocket(active, "voice websocket sent invalid PCM16 output");
						return;
					}
					try {
						this.audioSink.write(new Uint8Array(pcm24));
						this.outputBytes += pcm24.byteLength;
					} catch (error) {
						this.failedSocket(active, error);
					}
					return;
				}
				try {
					const event = parseServerControl(message.data);
					if (event.type === "consent.required") {
						const remainingMs = event.expiresAt - this.now();
						if (this.snapshot.phase !== "connecting" || event.sessionId !== active.sessionId || remainingMs <= 0 || remainingMs > 3e5) throw new Error("voice disclosure does not match the active Session or has expired");
						this.challenge = event.challenge;
						const disclosure = {
							expiresAt: event.expiresAt,
							workspaceId: event.workspaceId,
							...event.disclosure
						};
						this.consentTimer = this.schedule(() => {
							if (!this.isActive(active) || this.snapshot.phase !== "awaiting-consent") return;
							this.failedSocket(active, "disclosure acceptance expired");
						}, remainingMs);
						this.publish({
							phase: "awaiting-consent",
							sessionId: active.sessionId,
							disclosure
						});
						return;
					}
					if (event.type === "ready") {
						const disclosure = this.snapshot.disclosure;
						if (this.snapshot.phase !== "authorizing" || disclosure === void 0 || event.sessionId !== active.sessionId || event.workspaceId !== disclosure.workspaceId) throw new Error("voice ready event does not match the accepted binding");
						this.publish({
							phase: "ready",
							sessionId: active.sessionId,
							disclosure,
							model: event.model,
							...this.snapshot.draftRevision === void 0 ? {} : { draftRevision: this.snapshot.draftRevision }
						});
						return;
					}
					if (event.type === "transcript") {
						if (this.snapshot.phase !== "responding") throw new Error("voice transcript arrived outside the active response");
						this.publish(event.role === "user" ? {
							...this.snapshot,
							userTranscript: event.text,
							userTranscriptFinal: event.final
						} : {
							...this.snapshot,
							assistantTranscript: event.text,
							assistantTranscriptFinal: event.final
						});
						return;
					}
					if (event.type === "turn.done") {
						if (this.snapshot.phase !== "responding") throw new Error("voice turn completed outside the active response");
						this.publish({
							...this.snapshot,
							phase: "completed",
							turnStatus: event.status
						});
						this.releaseRecord(active, true, 1e3, "turn complete");
						return;
					}
					if (event.type === "error") {
						this.failedSocket(active, `${event.code}: ${event.message}`);
						return;
					}
					if (event.type === "stopped") throw new Error(`unexpected voice stopped event in phase ${this.snapshot.phase}`);
					throw new Error(`unexpected voice event in phase ${this.snapshot.phase}`);
				} catch (error) {
					this.failedSocket(active, error);
				}
			}
			failedSocket(active, error) {
				if (!this.isActive(active)) return;
				const sessionId = active.sessionId;
				this.releaseRecord(active, true);
				this.fail(sessionId, error);
			}
			closed(active, event) {
				if (!this.isActive(active)) return;
				this.releaseRecord(active, false);
				const detail = event.reason === "" ? `code ${String(event.code)}` : event.reason;
				this.fail(active.sessionId, /* @__PURE__ */ new Error(`voice websocket closed unexpectedly (${detail})`));
			}
			fail(sessionId, error) {
				if (this.disposed) return;
				const message = error instanceof Error ? error.message : String(error);
				this.resetTurn();
				this.publish({
					phase: "error",
					sessionId,
					error: message
				});
			}
			resetTurn() {
				const capture = this.capture;
				this.capture = void 0;
				if (capture !== void 0) try {
					capture.capture.stop(false);
				} catch {}
				this.inputBytes = 0;
				this.outputBytes = 0;
				this.composerBinding = void 0;
				try {
					this.audioSink.reset();
				} catch {}
			}
			async prepareCapture(active, record) {
				try {
					await Promise.all([this.audioSink.prepare(), record.capture.start()]);
				} catch (error) {
					const stillActive = this.isCaptureActive(active, record);
					try {
						record.capture.stop(false);
					} catch {}
					if (this.capture === record) this.capture = void 0;
					if (stillActive) this.failedSocket(active, error);
					return;
				}
				if (!this.isCaptureActive(active, record) || this.snapshot.phase !== "preparing-audio") {
					try {
						record.capture.stop(false);
					} catch {}
					if (this.capture === record) this.capture = void 0;
					return;
				}
				this.publish({
					...this.snapshot,
					phase: "recording"
				});
			}
			capturedPcm16(record, chunk) {
				const active = this.active;
				if (active === void 0 || !this.isCaptureActive(active, record) || this.snapshot.phase !== "preparing-audio" && this.snapshot.phase !== "recording") return;
				this.relayPcm16(active, chunk);
			}
			captureLimit(record) {
				const active = this.active;
				if (active === void 0 || !this.isCaptureActive(active, record) || this.snapshot.phase !== "preparing-audio" && this.snapshot.phase !== "recording") return;
				this.capture = void 0;
				this.commitActiveTurn(active, ["preparing-audio", "recording"]);
			}
			captureError(record, error) {
				const active = this.active;
				if (active === void 0 || !this.isCaptureActive(active, record)) return;
				this.capture = void 0;
				this.failedSocket(active, error);
			}
			isCaptureActive(active, record) {
				return this.isActive(active) && this.capture === record && record.generation === this.generation && record.sessionId === active.sessionId;
			}
			isActive(active) {
				return !this.disposed && this.active === active && active.generation === this.generation;
			}
			releaseActive(code, reason) {
				const active = this.active;
				if (active !== void 0) this.releaseRecord(active, true, code, reason);
				else this.clearConsentTimer();
			}
			releaseRecord(active, close, code = CLIENT_FAILURE_CLOSE_CODE, reason = "invalid voice state") {
				if (this.active !== active) return;
				this.active = void 0;
				this.challenge = void 0;
				this.clearConsentTimer();
				active.socket.removeEventListener("open", active.onOpen);
				active.socket.removeEventListener("message", active.onMessage);
				active.socket.removeEventListener("error", active.onError);
				active.socket.removeEventListener("close", active.onClose);
				if (close && (active.socket.readyState === SOCKET_CONNECTING || active.socket.readyState === SOCKET_OPEN)) try {
					active.socket.close(code, reason);
				} catch {}
			}
			clearConsentTimer() {
				if (this.consentTimer === void 0) return;
				this.cancelScheduled(this.consentTimer);
				this.consentTimer = void 0;
			}
			publish(snapshot) {
				this.snapshot = snapshot;
				for (const listener of [...this.listeners]) try {
					listener();
				} catch (error) {
					console.error("DSH Live Voice snapshot listener failed:", error);
				}
			}
		};
		//#endregion
		//#region src/client/locales.ts
		const NS = "guardedVoice";
		const en = {
			"control.start": "Open DSH Live Voice",
			"control.stop": "Close DSH Live Voice",
			"control.otherSession": "DSH Live Voice is open in another session",
			"panel.connecting": "Opening DSH Live Voice…",
			"panel.title": "Before voice is enabled",
			"panel.preview": "Manual-turn foundation",
			"panel.destination": "Microphone audio destination",
			"panel.context": "Harness context exported",
			"panel.authority": "Execution authority",
			"panel.retention": "Provider audio-retention promise",
			"panel.milestone": "What this build does now",
			"panel.none": "None",
			"panel.proposalOnly": "Proposal only; it cannot submit or execute work",
			"panel.retentionUnknown": "Not specified in the Qwen realtime-audio documentation",
			"panel.noAudio": "One bounded manual turn after this acceptance",
			"panel.accept": "Continue setup",
			"panel.cancel": "Cancel",
			"panel.authorizing": "Opening the consent-bound provider session…",
			"panel.ready": "Manual-turn transport ready",
			"panel.readyDetail": "Start one bounded microphone turn. Audio goes only to the disclosed Qwen realtime endpoint.",
			"panel.record": "Start recording",
			"panel.preparingAudio": "Waiting for microphone permission…",
			"panel.permissionDetail": "Your browser controls this permission. Cancelling closes all capture resources.",
			"panel.recording": "Recording one bounded turn",
			"panel.recordingDetail": "Finish explicitly to request an answer; the 30-second hard cap also ends the turn. This cannot submit the Harness composer or run tools.",
			"panel.finishTurn": "Finish and request answer",
			"panel.responding": "Qwen is answering the committed manual turn…",
			"panel.completed": "Manual turn completed",
			"panel.userTranscript": "You",
			"panel.assistantTranscript": "Assistant",
			"panel.useUserAsDraft": "Use my transcript as draft",
			"panel.draftConflict": "The composer changed after voice consent. Copy the transcript manually to avoid overwriting newer work.",
			"panel.error": "DSH Live Voice setup failed",
			"panel.retry": "Try again",
			"panel.dismiss": "Dismiss",
			"panel.session": "Session",
			"panel.workspace": "Workspace",
			"panel.expires": "Disclosure expires"
		};
		const zh = {
			"control.start": "打开 DSH Live Voice",
			"control.stop": "关闭 DSH Live Voice",
			"control.otherSession": "DSH Live Voice 已在另一会话中打开",
			"panel.connecting": "正在打开 DSH Live Voice…",
			"panel.title": "启用语音前",
			"panel.preview": "手动轮次基础功能",
			"panel.destination": "麦克风音频目的地",
			"panel.context": "导出的 Harness 上下文",
			"panel.authority": "执行权限",
			"panel.retention": "提供方的音频保留承诺",
			"panel.milestone": "当前版本实际执行的操作",
			"panel.none": "无",
			"panel.proposalOnly": "仅生成提案；不能提交或执行工作",
			"panel.retentionUnknown": "Qwen 实时音频文档未说明",
			"panel.noAudio": "确认后仅允许一个有界手动轮次",
			"panel.accept": "继续设置",
			"panel.cancel": "取消",
			"panel.authorizing": "正在打开绑定此确认的提供方会话…",
			"panel.ready": "手动轮次传输已就绪",
			"panel.readyDetail": "开始一个有界麦克风轮次。音频只会发送到已披露的 Qwen 实时端点。",
			"panel.record": "开始录音",
			"panel.preparingAudio": "正在等待麦克风权限…",
			"panel.permissionDetail": "此权限由浏览器控制。取消会关闭所有录音资源。",
			"panel.recording": "正在录制一个有界轮次",
			"panel.recordingDetail": "请明确结束录音以请求回答；达到 30 秒硬限制时也会结束此轮次。此功能不能提交 Harness 编辑器内容或运行工具。",
			"panel.finishTurn": "结束并请求回答",
			"panel.responding": "Qwen 正在回答已提交的手动轮次…",
			"panel.completed": "手动轮次已完成",
			"panel.userTranscript": "你",
			"panel.assistantTranscript": "助手",
			"panel.useUserAsDraft": "将我的转录文本用作草稿",
			"panel.draftConflict": "语音确认后编辑器已发生变化。请手动复制转录文本，以免覆盖较新的内容。",
			"panel.error": "DSH Live Voice 设置失败",
			"panel.retry": "重试",
			"panel.dismiss": "关闭",
			"panel.session": "会话",
			"panel.workspace": "工作区",
			"panel.expires": "披露确认到期时间"
		};
		//#endregion
		//#region src/client/page-lifecycle.ts
		/** Release browser-owned resources before this document leaves its lifecycle. */
		function bindPageLifecycleCleanup(target, pagehideCleanup, pluginCleanup) {
			let disposed = false;
			const cleanupPage = () => {
				if (disposed) return;
				pagehideCleanup();
			};
			target.addEventListener("pagehide", cleanupPage);
			return () => {
				if (disposed) return;
				disposed = true;
				target.removeEventListener("pagehide", cleanupPage);
				pluginCleanup();
			};
		}
		//#endregion
		//#region \0dsh-css:src/client/voice.module.css.mjs
		const css = ".qQ6utW_voiceButton{box-sizing:border-box;width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:1px solid #0000;border-radius:7px;place-items:center;padding:0;display:inline-grid}.qQ6utW_voiceButton:hover:not(:disabled),.qQ6utW_voiceButtonActive{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}.qQ6utW_voiceButton:disabled{cursor:not-allowed;opacity:.45}.qQ6utW_voiceButton:focus-visible,.qQ6utW_primaryButton:focus-visible,.qQ6utW_secondaryButton:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.qQ6utW_panel{border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border-radius:12px;gap:10px;padding:14px;display:grid;box-shadow:0 8px 24px #0000001a}.qQ6utW_panelError{border-color:var(--dsw-alias-state-error-primary)}.qQ6utW_panelReady{border-color:var(--dsw-alias-state-success-primary)}.qQ6utW_panelRecording{border-color:var(--dsw-alias-brand-primary)}.qQ6utW_eyebrow{color:var(--dsw-alias-brand-primary);letter-spacing:.08em;text-transform:uppercase;font-size:11px;font-weight:650}.qQ6utW_panelHeading{margin:0;font-size:14px;font-weight:650}.qQ6utW_detail,.qQ6utW_meta{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px}.qQ6utW_disclosureGrid,.qQ6utW_transcripts{gap:8px;margin:0;display:grid}.qQ6utW_transcripts>div{gap:2px;display:grid}.qQ6utW_transcripts dt{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:650}.qQ6utW_transcripts dd{min-height:1.4em;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font-size:12px}.qQ6utW_disclosureGrid>div{grid-template-columns:minmax(150px,.8fr) minmax(0,1.2fr);gap:12px;display:grid}.qQ6utW_disclosureGrid dt,.qQ6utW_disclosureGrid dd{margin:0;font-size:12px}.qQ6utW_disclosureGrid dt{color:var(--dsw-alias-label-secondary)}.qQ6utW_binding{color:var(--dsw-alias-label-secondary);flex-wrap:wrap;gap:6px 12px;font-size:11px;display:flex}.qQ6utW_binding code{color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}.qQ6utW_actions{justify-content:flex-end;gap:8px;display:flex}.qQ6utW_primaryButton,.qQ6utW_secondaryButton{min-height:30px;font:inherit;cursor:pointer;border-radius:8px;padding:0 12px}.qQ6utW_primaryButton:disabled,.qQ6utW_secondaryButton:disabled{cursor:not-allowed;opacity:.5}.qQ6utW_primaryButton{border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);background:var(--dsw-alias-brand-primary)}.qQ6utW_secondaryButton{border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}@media (width<=640px){.qQ6utW_disclosureGrid>div{grid-template-columns:1fr;gap:2px}}";
		const tagId = "dsh-live-voice/voice.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-live-voice";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var voice_module_css_default = {
			"actions": "qQ6utW_actions",
			"binding": "qQ6utW_binding",
			"detail": "qQ6utW_detail",
			"disclosureGrid": "qQ6utW_disclosureGrid",
			"eyebrow": "qQ6utW_eyebrow",
			"meta": "qQ6utW_meta",
			"panel": "qQ6utW_panel",
			"panelError": "qQ6utW_panelError",
			"panelHeading": "qQ6utW_panelHeading",
			"panelReady": "qQ6utW_panelReady",
			"panelRecording": "qQ6utW_panelRecording",
			"primaryButton": "qQ6utW_primaryButton",
			"secondaryButton": "qQ6utW_secondaryButton",
			"transcripts": "qQ6utW_transcripts",
			"voiceButton": "qQ6utW_voiceButton",
			"voiceButtonActive": "qQ6utW_voiceButtonActive"
		};
		//#endregion
		//#region src/client/VoiceControl.tsx
		/** Compact DSH Live Voice control inside the composer tool row. */
		function VoiceControl({ sessionId, useVoice, startVoice, stopVoice, t }) {
			const voice = useVoice((snapshot) => snapshot);
			const here = voice.sessionId === String(sessionId);
			const occupiedElsewhere = voice.phase !== "idle" && voice.phase !== "error" && !here;
			const active = here && voice.phase !== "idle" && voice.phase !== "error";
			const label = occupiedElsewhere ? t("control.otherSession") : active ? t("control.stop") : t("control.start");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				className: `${voice_module_css_default.voiceButton} ${active ? voice_module_css_default.voiceButtonActive : ""}`,
				"aria-label": label,
				"aria-pressed": active,
				title: label,
				disabled: occupiedElsewhere,
				"data-state": here ? voice.phase : "idle",
				onClick: () => {
					if (active) stopVoice(String(sessionId));
					else startVoice(String(sessionId));
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					viewBox: "0 0 16 16",
					width: "16",
					height: "16",
					"aria-hidden": "true",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "5",
						y: "2",
						width: "6",
						height: "8",
						rx: "3",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.4"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2M5.5 14h5",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.4",
						strokeLinecap: "round"
					})]
				})
			});
		}
		//#endregion
		//#region src/client/VoicePanel.tsx
		/** User-visible disclosure and setup result; it never receives the bearer challenge. */
		function VoicePanel({ sessionId, useVoice, startVoice, acceptDisclosure, stopVoice, beginVoiceCapture, finishVoiceCapture, getVoiceSnapshot, isComposerBindingCurrent, claimVoiceDraftHandoff, inputActions, input, t }) {
			const voice = useVoice((snapshot) => snapshot);
			if (voice.sessionId !== String(sessionId) || voice.phase === "idle") return null;
			if (voice.phase === "connecting") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: voice_module_css_default.panel,
				role: "status",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("panel.connecting") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: voice_module_css_default.secondaryButton,
					onClick: () => {
						stopVoice(String(sessionId));
					},
					children: t("panel.cancel")
				})]
			});
			if (voice.phase === "error") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: `${voice_module_css_default.panel} ${voice_module_css_default.panelError}`,
				role: "alert",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: voice_module_css_default.panelHeading,
						children: t("panel.error")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: voice_module_css_default.detail,
						children: voice.error
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: voice_module_css_default.actions,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: voice_module_css_default.secondaryButton,
							onClick: () => {
								stopVoice(String(sessionId));
							},
							children: t("panel.dismiss")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: voice_module_css_default.primaryButton,
							onClick: () => {
								startVoice(String(sessionId));
							},
							children: t("panel.retry")
						})]
					})
				]
			});
			const disclosure = voice.disclosure;
			if (disclosure === void 0) return null;
			if (voice.phase === "authorizing") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: voice_module_css_default.panel,
				role: "status",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("panel.authorizing") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: voice_module_css_default.secondaryButton,
					onClick: () => {
						stopVoice(String(sessionId));
					},
					children: t("panel.cancel")
				})]
			});
			if (voice.phase === "ready") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: `${voice_module_css_default.panel} ${voice_module_css_default.panelReady}`,
				role: "status",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: voice_module_css_default.panelHeading,
						children: t("panel.ready")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: voice_module_css_default.detail,
						children: t("panel.readyDetail")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: voice_module_css_default.meta,
						children: voice.model
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: voice_module_css_default.actions,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: voice_module_css_default.secondaryButton,
							onClick: () => {
								stopVoice(String(sessionId));
							},
							children: t("control.stop")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: voice_module_css_default.primaryButton,
							onClick: () => {
								beginVoiceCapture(String(sessionId));
							},
							children: t("panel.record")
						})]
					})
				]
			});
			if (voice.phase === "preparing-audio") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: voice_module_css_default.panel,
				role: "status",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: voice_module_css_default.panelHeading,
						children: t("panel.preparingAudio")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: voice_module_css_default.detail,
						children: t("panel.permissionDetail")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: voice_module_css_default.secondaryButton,
						onClick: () => {
							stopVoice(String(sessionId));
						},
						children: t("panel.cancel")
					})
				]
			});
			if (voice.phase === "recording") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: `${voice_module_css_default.panel} ${voice_module_css_default.panelRecording}`,
				role: "status",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: voice_module_css_default.panelHeading,
						children: t("panel.recording")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: voice_module_css_default.detail,
						children: t("panel.recordingDetail")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: voice_module_css_default.actions,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: voice_module_css_default.secondaryButton,
							onClick: () => {
								stopVoice(String(sessionId));
							},
							children: t("panel.cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: voice_module_css_default.primaryButton,
							onClick: () => {
								finishVoiceCapture(String(sessionId));
							},
							children: t("panel.finishTurn")
						})]
					})
				]
			});
			if (voice.phase === "responding" || voice.phase === "completed") {
				const composerBindingCurrent = isComposerBindingCurrent(String(sessionId), inputActions);
				const draftConflict = voice.draftRevision !== void 0 && input.draftRev !== voice.draftRevision || !composerBindingCurrent;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					className: `${voice_module_css_default.panel} ${voice.phase === "completed" ? voice_module_css_default.panelReady : ""}`,
					role: "status",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: voice_module_css_default.panelHeading,
							children: t(voice.phase === "completed" ? "panel.completed" : "panel.responding")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
							className: voice_module_css_default.transcripts,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("panel.userTranscript") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: voice.userTranscript ?? "" })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("panel.assistantTranscript") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: voice.assistantTranscript ?? "" })] })]
						}),
						draftConflict ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							className: voice_module_css_default.detail,
							children: t("panel.draftConflict")
						}) : null,
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: voice_module_css_default.actions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: voice_module_css_default.secondaryButton,
								onClick: () => {
									stopVoice(String(sessionId));
								},
								children: t("control.stop")
							}), voice.phase === "completed" && voice.turnStatus === "completed" && voice.userTranscriptFinal === true && voice.userTranscript !== void 0 && voice.userTranscript.trim() !== "" && voice.draftRevision !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: voice_module_css_default.primaryButton,
								disabled: input.draftRev !== voice.draftRevision || !composerBindingCurrent,
								title: input.draftRev === voice.draftRevision && composerBindingCurrent ? void 0 : t("panel.draftConflict"),
								onClick: () => {
									const current = getVoiceSnapshot();
									if (current.phase === "completed" && current.sessionId === String(sessionId) && current.turnStatus === "completed" && current.userTranscriptFinal === true && current.userTranscript !== void 0 && current.userTranscript.trim() !== "" && current.userTranscript === voice.userTranscript && current.draftRevision === voice.draftRevision && input.draftRev === current.draftRevision && claimVoiceDraftHandoff(String(sessionId), inputActions, current.draftRevision)) inputActions.setDraft(current.userTranscript);
								},
								children: t("panel.useUserAsDraft")
							}) : null]
						})
					]
				});
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: voice_module_css_default.panel,
				"aria-label": t("panel.title"),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: voice_module_css_default.eyebrow,
						children: t("panel.preview")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
						className: voice_module_css_default.panelHeading,
						children: t("panel.title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dl", {
						className: voice_module_css_default.disclosureGrid,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("panel.destination") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: disclosure.audioDestination })] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("panel.context") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: t("panel.none") })] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("panel.authority") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: t("panel.proposalOnly") })] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("panel.retention") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: t("panel.retentionUnknown") })] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: t("panel.milestone") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: t("panel.noAudio") })] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: voice_module_css_default.binding,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								t("panel.session"),
								": ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: voice.sessionId })
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								t("panel.workspace"),
								": ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: disclosure.workspaceId })
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								t("panel.expires"),
								": ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("time", {
									dateTime: new Date(disclosure.expiresAt).toISOString(),
									children: new Date(disclosure.expiresAt).toLocaleTimeString()
								})
							] })
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: voice_module_css_default.actions,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: voice_module_css_default.secondaryButton,
							onClick: () => {
								stopVoice(String(sessionId));
							},
							children: t("panel.cancel")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: voice_module_css_default.primaryButton,
							onClick: () => {
								acceptDisclosure(String(sessionId), input.draftRev, inputActions);
							},
							children: t("panel.accept")
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Browser services required by the two DSH Live Voice slot contributions. */
		const inject = ["slots", "locale"];
		/** Mount the user-visible, exact-session disclosure flow. */
		function apply(ctx) {
			const raw = globalThis[CLIENT_BOOT_GLOBAL];
			const controller = new VoiceClientController({
				route: parseGuardedVoiceClientBoot(raw).route,
				audioSink: new BrowserPcmPlaybackSink(),
				captureFactory: (handlers) => new BrowserPcmCapture(handlers)
			});
			const injected = () => ({
				hooks: { voice: controller },
				getVoiceSnapshot: controller.getSnapshot,
				startVoice: (sessionId) => {
					controller.start(sessionId);
				},
				acceptDisclosure: (sessionId, draftRevision, composerIdentity) => {
					controller.accept(sessionId, draftRevision, composerIdentity);
				},
				isComposerBindingCurrent: (sessionId, composerIdentity) => controller.isComposerBindingCurrent(sessionId, composerIdentity),
				claimVoiceDraftHandoff: (sessionId, composerIdentity, draftRevision) => controller.claimDraftHandoff(sessionId, composerIdentity, draftRevision),
				stopVoice: (sessionId) => {
					controller.stop(sessionId);
				},
				appendVoicePcm16: (sessionId, chunk) => {
					controller.appendPcm16(sessionId, chunk);
				},
				commitVoiceTurn: (sessionId) => {
					controller.commitTurn(sessionId);
				},
				beginVoiceCapture: (sessionId) => {
					controller.beginCapture(sessionId);
				},
				finishVoiceCapture: (sessionId) => {
					controller.finishCapture(sessionId);
				}
			});
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-live-voice: browser dictionaries");
			ctx.effect(() => bindPageLifecycleCleanup(window, () => {
				controller.stop();
			}, () => {
				controller.dispose();
			}), "dsh-live-voice: browser and document cleanup");
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "guarded-live-voice",
				order: 30,
				locale: NS,
				inject: injected
			}, VoiceControl));
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "guarded-live-voice-disclosure",
				order: 30,
				locale: NS,
				inject: injected
			}, VoicePanel));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
