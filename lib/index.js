import WebSocket$1, { WebSocket, WebSocketServer } from "ws";
import z from "@deepseek-ai/schemastery";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
//#region src/config.ts
/** Plugin configuration schema and defaults (cordis.yml row config). */
/** Speech synthesis engines; 'auto' picks the first cloud engine whose credentials exist. */
const SPEECH_ENGINES = [
	"auto",
	"system",
	"dashscope",
	"volcengine"
];
/** Speech recognition engines; 'auto' picks the first one whose credentials exist, 'off' disables voice input. */
const ASR_ENGINES = [
	"auto",
	"off",
	"dashscope",
	"volcengine"
];
/** Configurable fields; every deployment-varying choice lives here, never in code. */
const Config = z.object({
	engine: z.union([...SPEECH_ENGINES]).default("auto"),
	asrEngine: z.union([...ASR_ENGINES]).default("auto"),
	dashscopeModel: z.string().default("qwen3-tts-flash"),
	dashscopeAsrModel: z.string().default("paraformer-realtime-v2"),
	dashscopeVoice: z.string().default("Cherry"),
	volcengineVoice: z.string().default("zh_female_vv_uranus_bigtts"),
	volcengineResourceId: z.string().default("seed-tts-2.0"),
	volcengineAsrResourceId: z.string().default("volc.seedasr.sauc.duration"),
	maxTextLength: z.natural().default(8e3),
	cacheEntries: z.natural().default(64)
});
/**
* Mirrors the schema defaults for direct mounts without a config; the Loader
* path applies the schema's own defaults instead. Keep the two in lockstep.
*/
const DEFAULT_CONFIG = {
	engine: "auto",
	asrEngine: "auto",
	dashscopeModel: "qwen3-tts-flash",
	dashscopeAsrModel: "paraformer-realtime-v2",
	dashscopeVoice: "Cherry",
	volcengineVoice: "zh_female_vv_uranus_bigtts",
	volcengineResourceId: "seed-tts-2.0",
	volcengineAsrResourceId: "volc.seedasr.sauc.duration",
	maxTextLength: 8e3,
	cacheEntries: 64
};
//#endregion
//#region src/tts/types.ts
/** Provider contract shared by the cloud TTS engines. */
/** Provider failure carrying whether an identical retry can succeed. */
var TtsError = class extends Error {
	retryable;
	/**
	* @param message - provider diagnostic for logs and the route answer.
	* @param retryable - true for transient failures (timeout, 5xx, throttle,
	*   provider-busy); false for deterministic ones (auth, voice, text).
	*/
	constructor(message, retryable) {
		super(message);
		this.retryable = retryable;
	}
};
//#endregion
//#region src/tts/dashscope.ts
/**
* Aliyun Bailian (DashScope) TTS provider over the non-realtime multimodal
* generation endpoint: one POST per chunk, Bearer key, Base64 audio (or a
* 24-hour result URL) in the JSON response.
*/
const ENDPOINT$3 = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
/** Non-realtime API input limit for non-Qwen-TTS models, kept below it for margin. */
const MAX_CHARS$1 = 550;
/** One chunk synthesis budget; timeouts are transient by nature. */
const REQUEST_TIMEOUT_MS$1 = 3e4;
/** Run one fetch, classifying network and timeout throws as retryable. */
async function fetchOrRetryable$1(url, init) {
	try {
		return await fetch(url, {
			...init,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS$1)
		});
	} catch (error) {
		throw new TtsError(`dashscope tts request failed: ${error instanceof Error ? error.message : String(error)}`, true);
	}
}
/** Build the DashScope provider.
* @param config - model and voice settings.
* @param apiKey - SPEECH_DASHSCOPE_API_KEY credential.
*/
function dashscopeProvider(config, apiKey) {
	return {
		engine: "dashscope",
		settingsKey: `${config.model}/${config.voice}`,
		contentType: "audio/wav",
		maxChars: MAX_CHARS$1,
		async synthesize(text) {
			const response = await fetchOrRetryable$1(ENDPOINT$3, {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json"
				},
				body: JSON.stringify({
					model: config.model,
					input: {
						text,
						voice: config.voice
					}
				})
			});
			const payload = await response.json();
			if (!response.ok || payload.code !== void 0 && payload.code !== "") throw new TtsError(`dashscope tts failed (${response.status}): ${payload.code ?? ""} ${payload.message ?? ""}`.trim(), response.status >= 500 || response.status === 429);
			const inline = payload.output?.audio?.data;
			if (inline !== void 0 && inline !== "") return {
				base64: inline,
				contentType: "audio/wav"
			};
			const url = payload.output?.audio?.url;
			if (url !== void 0) {
				const audioResponse = await fetchOrRetryable$1(url, { method: "GET" });
				if (!audioResponse.ok) throw new TtsError(`dashscope tts audio download failed (${audioResponse.status})`, audioResponse.status >= 500 || audioResponse.status === 429);
				return {
					base64: Buffer.from(await audioResponse.arrayBuffer()).toString("base64"),
					contentType: "audio/wav"
				};
			}
			throw new TtsError("dashscope tts response carried no audio", false);
		}
	};
}
//#endregion
//#region src/tts/volcengine.ts
/**
* Volcengine (Doubao) TTS provider over the V3 unidirectional HTTP endpoint:
* one POST per chunk, authenticated by a console API Key (`X-Api-Key` — the
* per-app Access Token of the legacy V1 API is not accepted here), with
* `X-Api-Resource-Id` selecting the model version and a newline-delimited
* JSON stream whose `data` fields carry Base64 MP3 until the `20000000`
* completion block. The speaker must belong to the granted resource: 2.0
* voices under `seed-tts-2.0`, public voices under `volc.service_type.10029`.
*/
const ENDPOINT$2 = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";
/** V3 request text budget; kept conservative for CJK-heavy text. */
const MAX_CHARS = 280;
/** One chunk synthesis budget; timeouts are transient by nature. */
const REQUEST_TIMEOUT_MS = 3e4;
/** Stream completion code carried by the final JSON block. */
const COMPLETION_CODE = 2e7;
/** Run one fetch, classifying network and timeout throws as retryable. */
async function fetchOrRetryable(url, init) {
	try {
		return await fetch(url, {
			...init,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch (error) {
		throw new TtsError(`volcengine tts request failed: ${error instanceof Error ? error.message : String(error)}`, true);
	}
}
/**
* Build the Volcengine V3 provider.
* @param config - voice plus the resource id selecting the model.
* @param apiKey - console API Key (控制台 API Key 管理创建的密钥).
*/
function volcengineProvider(config, apiKey) {
	return {
		engine: "volcengine",
		settingsKey: `${config.model}/${config.voice}`,
		contentType: "audio/mpeg",
		maxChars: MAX_CHARS,
		async synthesize(text) {
			const response = await fetchOrRetryable(ENDPOINT$2, {
				method: "POST",
				headers: {
					"X-Api-Key": apiKey,
					"X-Api-Resource-Id": config.model,
					"content-type": "application/json"
				},
				body: JSON.stringify({
					user: { uid: "dsh-speech-plugin" },
					req_params: {
						text,
						speaker: config.voice,
						audio_params: {
							format: "mp3",
							sample_rate: 24e3,
							speech_rate: 0
						}
					}
				})
			});
			if (!response.ok) {
				const body = await response.text();
				let message = body.slice(0, 200);
				try {
					const parsed = JSON.parse(body);
					message = parsed.message ?? parsed.header?.message ?? message;
				} catch {}
				throw new TtsError(`volcengine tts failed (${response.status}): ${message}`, response.status >= 500 || response.status === 429);
			}
			const parts = [];
			for (const line of (await response.text()).split("\n")) {
				const trimmed = line.trim();
				if (trimmed === "") continue;
				let block;
				try {
					block = JSON.parse(trimmed);
				} catch {
					throw new TtsError(`volcengine tts stream carried a malformed block: ${trimmed.slice(0, 120)}`, false);
				}
				if (block.header !== void 0) throw new TtsError(`volcengine tts failed (${String(block.header.code ?? "unknown")}): ${block.header.message ?? ""}`.trim(), false);
				if (block.code === 0) {
					if (typeof block.data === "string" && block.data !== "") parts.push(block.data);
					continue;
				}
				if (block.code === COMPLETION_CODE) break;
				throw new TtsError(`volcengine tts failed (${String(block.code ?? "unknown")}): ${block.message ?? ""}`.trim(), false);
			}
			if (parts.length === 0) throw new TtsError("volcengine tts response carried no audio", false);
			return {
				base64: parts.join(""),
				contentType: "audio/mpeg"
			};
		}
	};
}
//#endregion
//#region src/tts/split-text.ts
/**
* Sentence-aware chunking for cloud TTS input limits. Every provider caps one
* request (DashScope ~600 chars, Volcengine 1024 UTF-8 bytes ≈ 340 chars), so
* long messages are split on sentence enders and packed greedily; a sentence
* longer than the limit is hard-cut.
*/
/** Sentence enders shared by Chinese and Latin text, plus line breaks. */
const SENTENCE_ENDER = /[。！？!?；;\n]/;
/**
* Split one text into speech-sized chunks. The first chunk obeys
* `firstMaxChars` when smaller than `maxChars`: synthesis latency grows with
* text length, so a short first chunk starts playback while the rest is still
* synthesizing (the remaining chunks pack to the full limit).
* @param text - cleaned plain text to speak.
* @param maxChars - per-request character limit of the target engine.
* @param firstMaxChars - character budget for the first chunk only.
* @returns non-empty chunks, in order, each within its budget.
*/
function splitForSpeech(text, maxChars, firstMaxChars = maxChars) {
	const sentences = [];
	let current = "";
	for (const char of text) {
		current += char;
		if (SENTENCE_ENDER.test(char)) {
			sentences.push(current);
			current = "";
		}
	}
	if (current !== "") sentences.push(current);
	const chunks = [];
	let packed = "";
	let limit = firstMaxChars;
	const flush = () => {
		if (packed !== "") chunks.push(packed);
		packed = "";
		limit = maxChars;
	};
	for (const sentence of sentences) {
		if (sentence.length > limit) {
			flush();
			for (let index = 0; index < sentence.length; index += maxChars) chunks.push(sentence.slice(index, index + maxChars));
			continue;
		}
		if (packed.length + sentence.length > limit) flush();
		packed += sentence;
	}
	flush();
	return chunks.filter((chunk) => chunk.trim() !== "");
}
//#endregion
//#region src/tts/service.ts
/**
* Host-side synthesis service: resolves the engine from config plus present
* credentials, splits long text into provider-sized chunks, synthesizes them
* in order, and caches whole-message responses so repeated clicks on the same
* message cost nothing.
*/
/** Attempts per chunk: the original call plus two retries for transient failures. */
const MAX_ATTEMPTS = 3;
/** Backoff between retries, linear in the attempt number. */
const RETRY_DELAY_MS = 400;
/** First-chunk character budget: synthesis latency grows with length, so a
* short opener starts playback in ~1-2s while the rest synthesizes behind it. */
const FIRST_CHUNK_CHARS = 80;
/** Promise-based delay without a trailing-timer leak risk. */
const delay = (ms) => new Promise((resolve) => {
	setTimeout(resolve, ms);
});
/** No cloud engine is usable; the browser falls back to system voices. */
var UnavailableError = class extends Error {};
/** Resolve the DashScope console API Key from the environment. */
function dashscopeApiKey() {
	const value = process.env.SPEECH_DASHSCOPE_API_KEY;
	return value !== void 0 && value !== "" ? value : void 0;
}
/** Resolve the Volcengine console API Key from the environment. */
function volcengineApiKey() {
	const value = process.env.SPEECH_VOLCENGINE_API_KEY;
	return value !== void 0 && value !== "" ? value : void 0;
}
/**
* The synthesis service: engine resolution, chunking, orchestration, cache.
*/
var SpeechTTSService = class {
	config;
	cache = /* @__PURE__ */ new Map();
	/**
	* @param config - resolved plugin configuration.
	*/
	constructor(config) {
		this.config = config;
	}
	/**
	* The active provider under the configured engine selector, or why none is.
	* 'auto' prefers DashScope, then Volcengine, by present credentials.
	*/
	provider() {
		const want = this.config.engine === "auto" ? ["dashscope", "volcengine"] : this.config.engine === "system" ? [] : [this.config.engine];
		for (const engine of want) if (engine === "dashscope") {
			const apiKey = dashscopeApiKey();
			if (apiKey !== void 0) return { provider: dashscopeProvider({
				model: this.config.dashscopeModel,
				voice: this.config.dashscopeVoice
			}, apiKey) };
			if (this.config.engine === "dashscope") return { reason: "engine is dashscope but SPEECH_DASHSCOPE_API_KEY is not set" };
		} else {
			const apiKey = volcengineApiKey();
			if (apiKey !== void 0) return { provider: volcengineProvider({
				model: this.config.volcengineResourceId,
				voice: this.config.volcengineVoice
			}, apiKey) };
			if (this.config.engine === "volcengine") return { reason: "engine is volcengine but SPEECH_VOLCENGINE_API_KEY is not set" };
		}
		return { reason: "engine is system or no cloud credentials are present" };
	}
	/**
	* Whether a cloud engine answers requests (drives the route's 503).
	*/
	available() {
		return "provider" in this.provider();
	}
	/**
	* The active provider's engine and media type, for the stream's header.
	*/
	describe() {
		const resolved = this.provider();
		return "provider" in resolved ? {
			engine: resolved.provider.engine,
			contentType: resolved.provider.contentType
		} : void 0;
	}
	/**
	* Synthesize one message, yielding each Base64 part the moment it is ready
	* so playback starts with the first chunk instead of waiting for the whole
	* message. A cache hit yields every part immediately. The cache is written
	* only after the final part, so a partial failure never poisons it.
	* @param text - cleaned plain text; at most `maxTextLength` characters.
	* @yields Base64 audio parts in playback order.
	*/
	async *synthesizeParts(text) {
		const resolved = this.provider();
		if (!("provider" in resolved)) throw new UnavailableError(resolved.reason);
		const provider = resolved.provider;
		const cacheKey = createHash("sha1").update(`${provider.engine}\0${provider.settingsKey}\0${text}`).digest("hex");
		const cached = this.cache.get(cacheKey);
		if (cached !== void 0) {
			for (const part of cached.parts) yield part;
			return;
		}
		const chunks = splitForSpeech(text, provider.maxChars, FIRST_CHUNK_CHARS);
		const parts = [];
		for (const chunk of chunks) {
			let base64;
			for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) try {
				base64 = (await provider.synthesize(chunk)).base64;
				break;
			} catch (error) {
				if (!(error instanceof TtsError && error.retryable) || attempt === MAX_ATTEMPTS) throw error;
				await delay(RETRY_DELAY_MS * attempt);
			}
			parts.push(base64);
			yield base64;
		}
		const response = {
			ok: true,
			engine: provider.engine,
			contentType: provider.contentType,
			parts
		};
		this.cache.set(cacheKey, response);
		while (this.cache.size > this.config.cacheEntries) {
			const oldest = this.cache.keys().next().value;
			if (oldest === void 0) break;
			this.cache.delete(oldest);
		}
	}
};
//#endregion
//#region src/asr/dashscope-asr.ts
/**
* Aliyun Bailian (DashScope) realtime ASR session over the Paraformer duplex
* WebSocket endpoint. Wire contract (cross-checked against the official doc):
* - handshake authenticates with an `Authorization: Bearer <key>` header;
* - client messages are JSON text: run-task starts the task (model + audio
*   format), finish-task ends it; audio rides raw binary frames in between;
* - server events are JSON text: task-started (ready), result-generated with
*   `payload.output.sentence` (`sentence_end` false = partial, true =
*   committed; `heartbeat` sentences are silence keep-alives to skip),
*   task-finished (natural end), task-failed (`header.error_code` /
*   `error_message`).
*/
const ENDPOINT$1 = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
/**
* One recognition session: connect, stream PCM frames, surface events.
* Lifecycle is explicit: start() → sendAudio()* → finish() → close().
*/
var DashscopeAsrSession = class {
	apiKey;
	model;
	socket;
	taskId = "";
	emitted;
	finishing = false;
	closed = false;
	/**
	* @param apiKey - DashScope API Key (`sk-` prefixed, from the Bailian console).
	* @param model - realtime ASR model name (e.g. `paraformer-realtime-v2`).
	* @param emit - receives recognition events after start() resolves.
	* @param onDone - invoked once when the task finishes (the natural end after
	* finish(): the last result is delivered) or the socket closes.
	*/
	constructor(apiKey, model, emit, onDone) {
		this.apiKey = apiKey;
		this.model = model;
		this.emitted = emit;
		this.done = onDone;
	}
	done;
	notifiedDone = false;
	/** Connect, run the task, and wait for the service's task-started event. */
	start() {
		return new Promise((resolve, reject) => {
			const settled = { done: false };
			this.taskId = randomUUID();
			const socket = new WebSocket$1(ENDPOINT$1, { headers: { authorization: `Bearer ${this.apiKey}` } });
			this.socket = socket;
			const fail = (message) => {
				if (settled.done) return;
				settled.done = true;
				reject(new Error(message));
			};
			const notifyDone = () => {
				if (this.notifiedDone) return;
				this.notifiedDone = true;
				this.done?.();
			};
			socket.on("unexpected-response", (_request, response) => {
				fail(`asr handshake rejected (http ${String(response.statusCode)})`);
			});
			socket.on("error", (error) => {
				fail(`asr socket error: ${error.message}`);
			});
			socket.on("open", () => {
				socket.send(JSON.stringify({
					header: {
						action: "run-task",
						task_id: this.taskId,
						streaming: "duplex"
					},
					payload: {
						task_group: "audio",
						task: "asr",
						function: "recognition",
						model: this.model,
						parameters: {
							format: "pcm",
							sample_rate: 16e3,
							heartbeat: true
						},
						input: {}
					}
				}));
			});
			socket.on("message", (data, isBinary) => {
				if (isBinary) return;
				let event;
				try {
					event = JSON.parse(data.toString("utf8"));
				} catch {
					return;
				}
				switch (event.header?.event) {
					case "task-started":
						if (!settled.done) {
							settled.done = true;
							this.emitted?.({ type: "ready" });
							resolve();
						}
						break;
					case "result-generated": {
						const sentence = event.payload?.output?.sentence;
						if (sentence === void 0 || sentence.heartbeat === true) break;
						if (sentence.text === void 0 || sentence.text === "") break;
						this.emitted?.(sentence.sentence_end === true ? {
							type: "final",
							text: sentence.text
						} : {
							type: "partial",
							text: sentence.text
						});
						break;
					}
					case "task-failed": {
						const code = `asr-${event.header?.error_code ?? "failed"}`;
						const message = (event.header?.error_message ?? "").slice(0, 300);
						if (!settled.done) {
							socket.close();
							fail(`${code}: ${message}`);
							return;
						}
						this.emitted?.({
							type: "error",
							code,
							message
						});
						notifyDone();
						break;
					}
					case "task-finished":
						notifyDone();
						socket.close();
				}
			});
			socket.on("close", () => {
				if (!settled.done) {
					fail("asr socket closed before the task started");
					return;
				}
				notifyDone();
			});
		});
	}
	/** Forward one PCM16/16k/mono chunk as a raw binary frame. No-op after finish() or before the task starts. */
	sendAudio(pcm) {
		if (this.closed || this.finishing) return;
		if (this.socket?.readyState !== WebSocket$1.OPEN) return;
		this.socket.send(pcm);
	}
	/** End the audio stream; the service answers the last result, then task-finished. */
	finish() {
		if (this.finishing || this.closed) return;
		this.finishing = true;
		if (this.socket?.readyState !== WebSocket$1.OPEN) return;
		this.socket.send(JSON.stringify({
			header: {
				action: "finish-task",
				task_id: this.taskId,
				streaming: "duplex"
			},
			payload: { input: {} }
		}));
	}
	/** Drop the connection without the end-of-stream handshake. */
	close() {
		this.closed = true;
		this.socket?.close();
	}
};
//#endregion
//#region src/asr/volcengine-asr.ts
/**
* Volcengine (Doubao) streaming ASR session over the V3 `sauc/bigmodel_async` WebSocket
* endpoint. Wire contract (cross-checked against the official doc):
* - handshake: the new console-API-Key mode authenticates with `X-Api-Key`,
*   `X-Api-Resource-Id`, `X-Api-Request-Id`, `X-Api-Sequence: -1`, and
*   `X-Api-Connect-Id`;
* - client frames: 4-byte header (version/size, type/flags, serial/compression,
*   reserved) + u32be payload size + gzip(payload); type 0x01 = JSON config,
*   0x02 = audio (flags 0x02 marks the final empty frame);
* - server frames: same header; type 0x0F = error (u32be code + u32be length +
*   JSON); full frames carry u32be sequence + u32be length + JSON with
*   `result.utterances[]` (`definite` false = partial, true = committed).
*   The sequence field is present only when flag 0x01 is set: bigasr 1.0's
*   opening frame (a bare result frame, no code ack) sends flags 0, so its
*   payload starts after the header + size at offset 8.
*/
const ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
/** Init-ack success code the service answers on the config frame. */
const OK_CODE = 1e3;
/** Per-result code meaning "no valid speech in this window"; not an error. */
const NO_VOICE_CODE = 1013;
/** Message-type nibbles of the protocol header. */
const MSG_FULL_CLIENT = 1;
const MSG_AUDIO_CLIENT = 2;
const MSG_SERVER_ERROR = 15;
/** Flag bit marking a server frame that carries a u32be sequence before the size. */
const FLAG_SEQUENCE = 1;
/** Build one client frame: header + u32be size + gzip(payload). */
function frame(messageType, flags, payload) {
	const compressed = gzipSync(payload);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(compressed.length, 0);
	return Buffer.concat([
		Buffer.from([
			17,
			messageType << 4 | flags,
			17,
			0
		]),
		size,
		compressed
	]);
}
/** Parse one binary server frame into its outcome. */
function parseServerFrame(data) {
	if (data.length < 8) return {
		type: "invalid",
		reason: "frame shorter than the fixed header"
	};
	if (data[1] >> 4 === MSG_SERVER_ERROR) {
		if (data.length < 12) return {
			type: "invalid",
			reason: "error frame shorter than its fixed header"
		};
		const code = data.readUInt32BE(4);
		const message = data.subarray(12).toString("utf8");
		return {
			type: "error",
			code: `asr-${String(code)}`,
			message: message.slice(0, 300)
		};
	}
	const sizeAt = (data[1] & FLAG_SEQUENCE) !== 0 ? 8 : 4;
	if (data.length < sizeAt + 4) return {
		type: "invalid",
		reason: "frame shorter than the fixed header"
	};
	const length = data.readUInt32BE(sizeAt);
	const jsonBytes = data.subarray(sizeAt + 4, sizeAt + 4 + length);
	let payload;
	try {
		payload = JSON.parse(jsonBytes.toString("utf8"));
	} catch {
		return {
			type: "invalid",
			reason: "frame carried malformed json"
		};
	}
	if (payload.code === NO_VOICE_CODE) return { type: "ignored" };
	if (payload.error !== void 0) return {
		type: "error",
		code: "asr-service",
		message: payload.error.slice(0, 300)
	};
	if (payload.result === void 0) {
		if ((payload.code ?? OK_CODE) === OK_CODE) return { type: "ignored" };
		return {
			type: "error",
			code: "asr-init",
			message: `init rejected: ${String(payload.code ?? "")} ${payload.error ?? ""}`.trim()
		};
	}
	const first = payload.result.utterances?.find((utterance) => utterance.text !== void 0 && utterance.text !== "");
	if (first === void 0) return { type: "ignored" };
	return first.definite === true ? {
		type: "final",
		text: first.text
	} : {
		type: "partial",
		text: first.text
	};
}
/**
* One recognition session: connect, stream PCM frames, surface events.
* Lifecycle is explicit: start() → sendAudio()* → finish() → close().
*/
var VolcengineAsrSession = class {
	apiKey;
	resourceId;
	socket;
	emitted;
	finishing = false;
	closed = false;
	/**
	* @param apiKey - console API Key (控制台 API Key 管理创建的密钥).
	* @param resourceId - ASR resource id selecting the model version and billing
	* mode (e.g. `volc.seedasr.sauc.duration`).
	* @param emit - receives recognition events after start() resolves.
	* @param onDone - invoked once when the provider socket closes after the
	* init ack (the natural end after finish(): the last result is delivered).
	*/
	constructor(apiKey, resourceId, emit, onDone) {
		this.apiKey = apiKey;
		this.resourceId = resourceId;
		this.emitted = emit;
		this.done = onDone;
	}
	done;
	notifiedDone = false;
	/** Connect, send the config frame, and wait for the service's ack. */
	start() {
		return new Promise((resolve, reject) => {
			const settled = { done: false };
			const requestId = randomUUID();
			const socket = new WebSocket$1(ENDPOINT, { headers: {
				"X-Api-Key": this.apiKey,
				"X-Api-Resource-Id": this.resourceId,
				"X-Api-Request-Id": requestId,
				"X-Api-Sequence": "-1",
				"X-Api-Connect-Id": randomUUID()
			} });
			this.socket = socket;
			const fail = (message) => {
				if (settled.done) return;
				settled.done = true;
				reject(new Error(message));
			};
			socket.on("unexpected-response", (_request, response) => {
				fail(`asr handshake rejected (http ${String(response.statusCode)})`);
			});
			socket.on("error", (error) => {
				fail(`asr socket error: ${error.message}`);
			});
			socket.on("open", () => {
				socket.send(frame(MSG_FULL_CLIENT, 0, Buffer.from(JSON.stringify({
					user: { uid: "dsh-speech-plugin" },
					request: {
						reqid: requestId,
						workflow: "audio_in,resample,partition,vad,fe,decode,itn,nlu_punctuate",
						show_utterances: true,
						result_type: "single",
						sequence: 1
					},
					audio: {
						format: "pcm",
						codec: "pcm",
						rate: 16e3,
						bits: 16,
						channel: 1,
						sample_rate: 16e3
					}
				}))));
			});
			socket.on("message", (data, isBinary) => {
				if (!isBinary) return;
				const outcome = parseServerFrame(data);
				if (!settled.done) {
					if (outcome.type === "error" || outcome.type === "invalid") {
						socket.close();
						fail(outcome.type === "error" ? `${outcome.code}: ${outcome.message}` : outcome.reason);
						return;
					}
					settled.done = true;
					this.emitted?.({ type: "ready" });
					resolve();
					return;
				}
				if (outcome.type === "ready" || outcome.type === "ignored") return;
				if (outcome.type === "invalid") {
					this.emitted?.({
						type: "error",
						code: "asr-frame",
						message: outcome.reason
					});
					return;
				}
				this.emitted?.(outcome);
			});
			socket.on("close", () => {
				if (!settled.done) {
					fail("asr socket closed before the init ack");
					return;
				}
				if (!this.notifiedDone) {
					this.notifiedDone = true;
					this.done?.();
				}
			});
		});
	}
	/** Forward one PCM16/16k/mono chunk. No-op after finish() or before the socket opens. */
	sendAudio(pcm) {
		if (this.closed || this.finishing) return;
		if (this.socket?.readyState !== WebSocket$1.OPEN) return;
		this.socket.send(frame(MSG_AUDIO_CLIENT, 0, pcm));
	}
	/** Send the final empty frame; the service answers the last result, then EOF. */
	finish() {
		if (this.finishing || this.closed) return;
		this.finishing = true;
		this.socket?.send(frame(MSG_AUDIO_CLIENT, 2, Buffer.alloc(0)));
	}
	/** Drop the connection without the end-of-stream handshake. */
	close() {
		this.closed = true;
		this.socket?.close();
	}
};
//#endregion
//#region src/index.ts
const ROUTE_PATH = "/dsh-speech/tts";
/** Route answering whether voice input can run (drives the mic button's state). */
const ASR_AVAILABLE_PATH = "/dsh-speech/asr/available";
/** Browser-facing WebSocket upgrade path carrying the recognition stream. */
const ASR_WS_PATH = "/dsh-speech/asr";
/**
* Resolve the ASR provider under the configured engine and present
* credentials. 'auto' prefers DashScope, then Volcengine — mirroring the TTS
* engine's own resolution order, but independently of it.
* @param config - resolved plugin configuration.
* @param emit - recognition event sink of the created session.
* @param onDone - natural-end callback of the created session.
*/
function resolveAsrSession(config, emit, onDone) {
	const want = config.asrEngine === "auto" ? ["dashscope", "volcengine"] : [config.asrEngine];
	for (const engine of want) {
		if (engine === "off") break;
		if (engine === "dashscope") {
			const apiKey = dashscopeApiKey();
			if (apiKey !== void 0) return { session: new DashscopeAsrSession(apiKey, config.dashscopeAsrModel, emit, onDone) };
			if (config.asrEngine === "dashscope") return { reason: "asrEngine is dashscope but SPEECH_DASHSCOPE_API_KEY is not set" };
		} else {
			const apiKey = volcengineApiKey();
			if (apiKey !== void 0) return { session: new VolcengineAsrSession(apiKey, config.volcengineAsrResourceId, emit, onDone) };
			if (config.asrEngine === "volcengine") return { reason: "asrEngine is volcengine but SPEECH_VOLCENGINE_API_KEY is not set" };
		}
	}
	return { reason: config.asrEngine === "off" ? "asrEngine is off; voice input is disabled" : "no ASR credentials; set SPEECH_DASHSCOPE_API_KEY or SPEECH_VOLCENGINE_API_KEY" };
}
/**
* Voice input availability under the ASR engine selector and present
* credentials; instantiating a session makes no connection before start().
*/
function asrAvailability(config) {
	const resolved = resolveAsrSession(config, () => {}, () => {});
	return "session" in resolved ? {
		available: true,
		reason: ""
	} : {
		available: false,
		reason: resolved.reason
	};
}
/** Refuse bodies above this size; a message within maxTextLength fits far below it. */
const MAX_BODY_BYTES = 1048576;
/** Read one JSON request body, refusing oversized bodies. */
async function readBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > MAX_BODY_BYTES) throw new Error("request body too large");
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/**
* Bridge one browser recognition stream to one provider session. Binary
* browser frames are PCM16/16k/mono; the browser's `{type:'stop'}` control
* message finalizes; every provider event is relayed as JSON text.
* @param client - the upgraded browser socket.
* @param config - resolved plugin configuration.
*/
async function bridgeAsr(client, config) {
	const send = (payload) => {
		if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
	};
	const resolved = resolveAsrSession(config, (event) => {
		if (event.type === "ready") send({ type: "ready" });
		else if (event.type === "error") send({
			type: "error",
			code: event.code,
			message: event.message
		});
		else send({
			type: event.type,
			text: event.text
		});
	}, () => {
		send({ type: "done" });
		client.close();
	});
	if (!("session" in resolved)) {
		send({
			type: "error",
			code: "asr-unavailable",
			message: resolved.reason
		});
		client.close();
		return;
	}
	const session = resolved.session;
	let started = false;
	const pendingAudio = [];
	client.on("message", (data, isBinary) => {
		if (isBinary) {
			if (started) session.sendAudio(data);
			else pendingAudio.push(data);
			return;
		}
		try {
			if (JSON.parse(data.toString("utf8")).type === "stop") session.finish();
		} catch {}
	});
	client.on("close", () => {
		session.close();
	});
	client.on("error", () => {
		session.close();
	});
	try {
		await session.start();
		started = true;
		for (const data of pendingAudio) session.sendAudio(data);
		pendingAudio.length = 0;
	} catch (error) {
		send({
			type: "error",
			code: "asr-start",
			message: error instanceof Error ? error.message : String(error)
		});
		session.close();
		client.close();
	}
}
/**
* Register the durable speech section and the TTS route when their Host
* services are composed.
* @param ctx - Host context that may acquire the settings and HTTP services.
* @param config - resolved plugin configuration.
*/
function apply(ctx, config = DEFAULT_CONFIG) {
	ctx.inject(["webServer"], (httpCtx) => {
		const service = new SpeechTTSService(config);
		httpCtx.effect(() => httpCtx.webServer.register({
			kind: "exact",
			path: ASR_AVAILABLE_PATH,
			handler: (request, response) => {
				if (request.method !== "GET") {
					response.writeHead(405, { "content-type": "application/json" });
					response.end(JSON.stringify({
						ok: false,
						code: "method-not-allowed"
					}));
					return;
				}
				const { available, reason } = asrAvailability(config);
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({
					ok: true,
					available,
					reason
				}));
			}
		}), "dsh-speech: asr availability route");
		const wss = new WebSocketServer({ noServer: true });
		httpCtx.effect(() => {
			const dispose = httpCtx.webServer.registerUpgrade({
				path: ASR_WS_PATH,
				handler: (request, socket, head) => {
					wss.handleUpgrade(request, socket, head, (client) => {
						bridgeAsr(client, config);
					});
				}
			});
			return () => {
				dispose();
				wss.close();
			};
		}, "dsh-speech: asr upgrade route");
		const log = (message) => {
			httpCtx.logger.info(`dsh-speech: ${message}`);
		};
		httpCtx.effect(() => httpCtx.webServer.register({
			kind: "exact",
			path: ROUTE_PATH,
			handler: async (request, response) => {
				if (request.method !== "POST") {
					response.writeHead(405, { "content-type": "application/json" });
					response.end(JSON.stringify({
						ok: false,
						code: "method-not-allowed"
					}));
					return;
				}
				let body;
				try {
					body = await readBody(request);
				} catch {
					response.writeHead(400, { "content-type": "application/json" });
					response.end(JSON.stringify({
						ok: false,
						code: "invalid-json"
					}));
					return;
				}
				const text = typeof body.text === "string" ? body.text.trim() : "";
				if (text === "") {
					response.writeHead(400, { "content-type": "application/json" });
					response.end(JSON.stringify({
						ok: false,
						code: "empty-text"
					}));
					return;
				}
				if (text.length > config.maxTextLength) {
					response.writeHead(413, { "content-type": "application/json" });
					response.end(JSON.stringify({
						ok: false,
						code: "text-too-long"
					}));
					return;
				}
				const described = service.describe();
				if (described === void 0) {
					response.writeHead(503, { "content-type": "application/json" });
					response.end(JSON.stringify({
						ok: false,
						code: "tts-unavailable"
					}));
					return;
				}
				response.writeHead(200, {
					"content-type": "application/x-ndjson",
					"cache-control": "no-store"
				});
				response.write(`${JSON.stringify({
					engine: described.engine,
					contentType: described.contentType
				})}\n`);
				try {
					for await (const part of service.synthesizeParts(text)) response.write(`${JSON.stringify({ part })}\n`);
					response.write(`${JSON.stringify({ done: true })}\n`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					httpCtx.logger.warn(`dsh-speech: tts synthesis failed: ${message}`);
					response.write(`${JSON.stringify({ error: {
						code: "tts-failed",
						message
					} })}\n`);
				}
				response.end();
			}
		}), "dsh-speech: tts route");
		if (service.available()) log(`cloud TTS route mounted at ${ROUTE_PATH}`);
		else log(`no cloud TTS credentials; ${ROUTE_PATH} answers 503 and the browser uses system voices`);
	});
}
//#endregion
export { Config, apply };
