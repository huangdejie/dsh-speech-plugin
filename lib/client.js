window.__ModuleLoader__.load({
	id: "dsh-speech-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
		//#region src/client/clean-text.ts
		/**
		* Speech text preparation: strips markdown artifacts the model's replies
		* carry, so neither engine reads markup syntax aloud. Code blocks and images
		* are dropped entirely (reading code aloud is noise); everything else keeps
		* its visible text.
		*/
		/**
		* Normalize one assistant message's text for speech.
		* @param text - raw text blocks of the message.
		* @returns plain spoken-language text; empty when nothing speakable remains.
		*/
		function cleanTextForSpeech(text) {
			return text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`([^`]*)`/g, "$1").replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "").replace(/^[ \t]*>[ \t]?/gm, "").replace(/^[ \t]*[-*+][ \t]+/gm, "").replace(/^[ \t]*\d+\.[ \t]+/gm, "").replace(/(\*\*|__|\*|~~)/g, "").replace(/\|/g, " ").replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\u{200D}\u{FE0F}]+/gu, " ").replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, " ").replace(/\s+/g, " ").trim();
		}
		//#endregion
		//#region src/client/controller.ts
		/** Host route answering cloud synthesis; same origin as the chat UI. */
		const TTS_ROUTE = "/dsh-speech/tts";
		/** Whole-message budget; multi-chunk synthesis of a long reply fits inside. */
		const ROUTE_TIMEOUT_MS = 12e4;
		const IDLE$1 = Object.freeze({ speakingMessageId: null });
		/** Pick a voice matching the UI language, tolerating an initially empty voices list. */
		function pickVoice() {
			const prefix = (document.documentElement.lang || navigator.language || "zh").split("-")[0].toLowerCase();
			return window.speechSynthesis.getVoices().find((voice) => voice.lang.toLowerCase().startsWith(prefix));
		}
		/** Decode one Base64 part into a Blob for an Audio element. */
		function partBlob(base64, contentType) {
			const bytes = atob(base64);
			const buffer = new Uint8Array(bytes.length);
			for (let index = 0; index < bytes.length; index += 1) buffer[index] = bytes.charCodeAt(index);
			return new Blob([buffer], { type: contentType });
		}
		/**
		* Per-session speech object layer: every message button in one Session shares
		* one instance, so `toggle` is the single authority over what is speaking.
		* In-flight playback is canceled by bumping `generation`; every async step
		* re-checks it, so a replaced or stopped playback never publishes stale state.
		*/
		var SpeechController = class {
			view = IDLE$1;
			listeners = /* @__PURE__ */ new Set();
			generation = 0;
			audio;
			systemWatch;
			disposed = false;
			/** Return the cached immutable view. */
			getSnapshot = () => this.view;
			/** Subscribe to view replacement. */
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			/**
			* Speak one message's text (markdown stripped here), replacing anything
			* already speaking; speaking the message already in flight stops it. Empty
			* or code-only text is a no-op.
			* @param messageId - target assistant message.
			* @param text - raw text blocks of that message.
			*/
			toggle(messageId, text) {
				if (this.disposed) return;
				if (this.view.speakingMessageId === messageId) {
					this.stop();
					return;
				}
				const cleaned = cleanTextForSpeech(text);
				if (cleaned === "") return;
				this.stop();
				this.publish({ speakingMessageId: messageId });
				const generation = this.generation;
				this.playCloud(messageId, cleaned, generation);
			}
			/** Stop any in-flight speech, cloud or system. */
			stop() {
				this.generation += 1;
				if (this.audio !== void 0) {
					this.audio.pause();
					this.audio = void 0;
				}
				if (this.systemWatch !== void 0) {
					window.clearInterval(this.systemWatch);
					this.systemWatch = void 0;
				}
				if (typeof speechSynthesis !== "undefined") window.speechSynthesis.cancel();
				this.publish(IDLE$1);
			}
			/** Stop speech and drop subscribers when the owning fiber unloads. */
			dispose() {
				this.disposed = true;
				this.stop();
				this.listeners.clear();
			}
			/** Try the cloud route, playing each streamed part as it arrives; fall back
			* to system voices only when nothing has played yet. */
			async playCloud(messageId, text, generation) {
				let played = false;
				try {
					const response = await fetch(TTS_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ text }),
						signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS)
					});
					if (generation !== this.generation) return;
					if (!response.ok || response.body === null) {
						const payload = await response.json().catch(() => void 0);
						const reason = payload === void 0 ? `http ${response.status}` : `${payload.code}: ${payload.message ?? ""}`;
						console.warn(`[dsh-speech] cloud TTS unavailable (${reason}); using system voices`);
						this.playSystem(messageId, text);
						return;
					}
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					let contentType = "audio/mpeg";
					let failed = false;
					for (;;) {
						const { done, value } = await reader.read();
						if (generation !== this.generation) {
							reader.cancel();
							return;
						}
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						let newline = buffer.indexOf("\n");
						while (newline !== -1) {
							const line = buffer.slice(0, newline).trim();
							buffer = buffer.slice(newline + 1);
							newline = buffer.indexOf("\n");
							if (line === "") continue;
							const parsed = JSON.parse(line);
							if (parsed.part === void 0) {
								if (parsed.engine !== void 0 && parsed.contentType !== void 0) contentType = parsed.contentType;
								else if (parsed.done === true) break;
								else if (parsed.error !== void 0) {
									console.warn(`[dsh-speech] cloud TTS stream failed (${parsed.error.code}: ${parsed.error.message ?? ""})`);
									failed = true;
								}
								continue;
							}
							const url = URL.createObjectURL(partBlob(parsed.part, contentType));
							try {
								await this.playUrl(url, generation);
								played = true;
							} finally {
								URL.revokeObjectURL(url);
							}
							if (generation !== this.generation) return;
						}
						if (failed) break;
					}
					if (!failed) this.publishIdle(messageId);
					else if (!played) this.playSystem(messageId, text);
					else this.publishIdle(messageId);
				} catch (error) {
					if (generation !== this.generation) return;
					if (!played) {
						console.warn(`[dsh-speech] cloud TTS request failed (${error instanceof Error ? error.message : String(error)}); using system voices`);
						this.playSystem(messageId, text);
					} else this.publishIdle(messageId);
				}
			}
			/** Play one object URL to its end; resolves early once superseded. */
			playUrl(url, generation) {
				return new Promise((resolve) => {
					const audio = new Audio(url);
					this.audio = audio;
					const settle = () => {
						if (this.audio === audio) this.audio = void 0;
						resolve();
					};
					audio.onended = settle;
					audio.onerror = settle;
					audio.play().catch(settle);
					if (generation !== this.generation) {
						audio.pause();
						settle();
					}
				});
			}
			/** Web Speech API path: one utterance for the whole text. */
			playSystem(messageId, text) {
				if (typeof speechSynthesis === "undefined") {
					this.publishIdle(messageId);
					return;
				}
				window.speechSynthesis.cancel();
				const utterance = new SpeechSynthesisUtterance(text);
				const voice = pickVoice();
				if (voice !== void 0) utterance.voice = voice;
				utterance.lang = voice?.lang ?? navigator.language;
				const settled = { done: false };
				const settle = () => {
					if (settled.done) return;
					settled.done = true;
					if (this.systemWatch !== void 0) {
						window.clearInterval(this.systemWatch);
						this.systemWatch = void 0;
					}
					this.publishIdle(messageId);
				};
				utterance.onend = settle;
				utterance.onerror = settle;
				window.speechSynthesis.speak(utterance);
				let idlePolls = 0;
				this.systemWatch = window.setInterval(() => {
					if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
						idlePolls = 0;
						return;
					}
					idlePolls += 1;
					if (idlePolls >= 2) settle();
				}, 500);
			}
			/** Clear the view only when the finished playback still owns it. */
			publishIdle(messageId) {
				if (this.disposed || this.view.speakingMessageId !== messageId) return;
				this.publish(IDLE$1);
			}
			/** Replace the view and contain subscriber failures at the observable boundary. */
			publish(view) {
				this.view = Object.freeze(view);
				for (const listener of this.listeners) try {
					listener();
				} catch (error) {
					console.error("[dsh-speech] subscriber threw:", error);
				}
			}
		};
		//#endregion
		//#region src/client/speech-watcher.ts
		/** Plain text of one assistant message (speech input skips every other block kind). */
		function assistantText(blocks) {
			return blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join("");
		}
		/** Settled assistant messages carrying a durable message id. */
		function settledMessages(snapshot) {
			return snapshot.nodes.filter((node) => node.kind === "assistant" && node.messageId !== void 0);
		}
		/**
		* Subscribe to one Session and speak newly settled assistant messages.
		* @param session - the Session whose snapshot is observed.
		* @param announceEnabled - reads the committed announce preference at flush time.
		* @param speak - receives each newly settled message's id and plain text.
		* @returns the unsubscriber.
		*/
		function watchSessionSpeech(session, announceEnabled, speak) {
			let watermark = 0;
			for (const node of settledMessages(session.getSnapshot())) watermark = Math.max(watermark, node.seq);
			return session.subscribe(() => {
				for (const node of settledMessages(session.getSnapshot())) {
					if (node.seq <= watermark) continue;
					watermark = node.seq;
					const messageId = node.messageId;
					if (messageId !== void 0 && announceEnabled()) speak(messageId, assistantText(node.blocks));
				}
			});
		}
		//#endregion
		//#region src/client/icons.tsx
		/**
		* Speaker glyph. ui-primitives ships no volume icon; this mirrors its 16px
		* outline style (currentColor, 16×16 viewBox) so the action strip reads as
		* one row.
		*/
		function IconSpeakerOutline16({ size = 16, className }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				className,
				viewBox: "0 0 16 16",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M2 6v4h2.7L8 13.3V2.7L4.7 6H2Z",
						fill: "currentColor"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M11 8c0-1.18-.68-2.19-1.67-2.69v5.38C10.32 10.19 11 9.18 11 8Z",
						fill: "currentColor"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M9.33 2.15v1.38c1.93.57 3.34 2.36 3.34 4.47s-1.41 3.9-3.34 4.47v1.38c2.68-.61 4.67-3 4.67-5.85s-1.99-5.24-4.67-5.85Z",
						fill: "currentColor"
					})
				]
			});
		}
		/** Microphone glyph mirroring the primitives' 16px outline style. */
		function IconMicOutline16({ size = 16, className }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				className,
				viewBox: "0 0 16 16",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M8 1.5a2.2 2.2 0 0 1 2.2 2.2v3.6a2.2 2.2 0 1 1-4.4 0V3.7A2.2 2.2 0 0 1 8 1.5Z",
					fill: "currentColor"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M3.8 6.6a.6.6 0 0 1 1.2 0v.7a3 3 0 0 0 6 0v-.7a.6.6 0 0 1 1.2 0v.7a4.2 4.2 0 0 1-3.6 4.16v1.34h1.7a.6.6 0 0 1 0 1.2H5.7a.6.6 0 0 1 0-1.2h1.7v-1.34A4.2 4.2 0 0 1 3.8 7.3v-.7Z",
					fill: "currentColor"
				})]
			});
		}
		//#endregion
		//#region src/client/SpeechActions.tsx
		/**
		* One message's speak control: a speaker button in the assistant action
		* strip. Click speaks the message's text; click again stops. The text is
		* resolved from the conversation snapshot at click time — a read-side lookup,
		* never a per-flush scan.
		*/
		/**
		* One message's speak/stop button.
		* @param props - the owner's message identity, the injected verbs, the shared
		* speech hook, and the copy.
		* @returns the button in its tooltip.
		*/
		function SpeechActions({ messageId, useSpeech, useSession, toggle, t }) {
			const speakingId = useSpeech((view) => view.speakingMessageId);
			const nodes = useSession((snapshot) => snapshot.nodes);
			const speaking = speakingId === messageId;
			const label = speaking ? t("action.stop") : t("action.speak");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label,
				side: "bottom",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dsh-speech-action",
					"aria-label": label,
					"aria-pressed": speaking,
					"data-active": speaking || void 0,
					onClick: () => {
						const node = nodes.find((candidate) => candidate.kind === "assistant" && candidate.messageId === messageId);
						toggle(messageId, node === void 0 ? "" : assistantText(node.blocks));
					},
					children: speaking ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconStopFill16, {}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconSpeakerOutline16, {})
				})
			});
		}
		//#endregion
		//#region src/client/AnnounceToggle.tsx
		/**
		* The session-header auto-announce toggle: flips the durable `ui-speech`
		* announce preference. The speaker stays highlighted while announce is on.
		*/
		/**
		* The header toggle button.
		* @param props - the injected announce hook, the setter, and the copy.
		* @returns the button in its tooltip.
		*/
		function AnnounceToggle({ useAnnounce, setAnnounce, t }) {
			const on = useAnnounce((mode) => mode) === "on";
			const label = on ? t("announce.disable") : t("announce.enable");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label,
				side: "bottom",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dsh-speech-toggle",
					"aria-label": label,
					"aria-pressed": on,
					"data-active": on || void 0,
					onClick: () => {
						setAnnounce(on ? "off" : "on");
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconSpeakerOutline16, {})
				})
			});
		}
		//#endregion
		//#region src/client/MicButton.tsx
		/**
		* The composer's voice-input button: click to dictate (live transcript
		* appends into the draft through the composer's public setDraft), click again
		* to finalize. Rendered disabled with its reason while no cloud ASR engine is
		* configured — voice input follows the cloud engines by design.
		*/
		/**
		* The composer mic control.
		* @param props - the injected mic hook, the draft write path, and the copy.
		* @returns the button in its tooltip.
		*/
		function MicButton({ useMic, recorder, inputActions, useInput, t }) {
			const status = useMic((view) => view.status);
			const micError = useMic((view) => view.error);
			const draft = useInput((input) => input.draft);
			const phase = useInput((input) => input.phase);
			const [unavailable, setUnavailable] = (0, react.useState)(null);
			const draftRef = (0, react.useRef)(draft);
			draftRef.current = draft;
			/** Draft content when recording began; the transcript is assembled on top of it. */
			const baseRef = (0, react.useRef)("");
			const committedRef = (0, react.useRef)("");
			const partialRef = (0, react.useRef)("");
			(0, react.useEffect)(() => {
				let alive = true;
				fetch("/dsh-speech/asr/available").then((response) => response.json()).then((answer) => {
					if (alive) setUnavailable(answer);
				}).catch(() => {
					if (alive) setUnavailable({
						available: false,
						reason: "availability check failed"
					});
				});
				return () => {
					alive = false;
				};
			}, []);
			(0, react.useEffect)(() => {
				if (phase === "submitting") recorder.cancel();
			}, [phase, recorder]);
			const writeDraft = (0, react.useCallback)(() => {
				const text = `${baseRef.current}${committedRef.current}${partialRef.current}`;
				inputActions.setDraft(text);
			}, [inputActions]);
			const toggle = (0, react.useCallback)(() => {
				if (status === "connecting" || status === "recording") {
					recorder.stop();
					return;
				}
				if (status === "error") return;
				baseRef.current = draftRef.current;
				committedRef.current = "";
				partialRef.current = "";
				recorder.start({
					onPartial: (text) => {
						partialRef.current = text;
						writeDraft();
					},
					onFinal: (text) => {
						committedRef.current += text;
						partialRef.current = "";
						writeDraft();
					},
					onDone: () => {}
				});
			}, [
				inputActions,
				recorder,
				status,
				writeDraft
			]);
			const disabled = unavailable !== null && !unavailable.available;
			const label = status === "recording" || status === "connecting" ? t("mic.stop") : disabled ? t("mic.unavailable") : t("mic.start");
			const tip = disabled ? `${label}（${unavailable?.reason ?? ""}）` : micError !== null ? micError : label;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: tip,
				side: "top",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dsh-speech-mic",
					"aria-label": label,
					"aria-pressed": status === "recording",
					"data-recording": status === "recording" || void 0,
					disabled: disabled || status === "error",
					onClick: toggle,
					children: status === "recording" || status === "connecting" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconStopFill16, {}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IconMicOutline16, {})
				})
			});
		}
		//#endregion
		//#region src/client/asr-client.ts
		/** Host ASR socket path on the page's own origin. */
		function asrUrl() {
			return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/dsh-speech/asr`;
		}
		const IDLE = Object.freeze({
			status: "idle",
			error: null
		});
		/** Convert one Float32 chunk to 16 kHz mono PCM16, averaging on downsample. */
		function toPcm16(input, inputRate) {
			if (inputRate === 16e3) {
				const out = new Int16Array(input.length);
				for (let i = 0; i < input.length; i += 1) out[i] = Math.max(-32768, Math.min(32767, Math.round(input[i] * 32768)));
				return out;
			}
			const ratio = inputRate / 16e3;
			const outLength = Math.floor(input.length / ratio);
			const out = new Int16Array(outLength);
			for (let i = 0; i < outLength; i += 1) {
				const start = Math.floor(i * ratio);
				const end = Math.min(input.length, Math.floor((i + 1) * ratio));
				let sum = 0;
				for (let j = start; j < end; j += 1) sum += input[j];
				const avg = sum / Math.max(1, end - start);
				out[i] = Math.max(-32768, Math.min(32767, Math.round(avg * 32768)));
			}
			return out;
		}
		/**
		* One recording session owner: starts capture and the ASR socket, forwards
		* audio, and publishes connection state. stop() finalizes; dispose() aborts.
		*/
		var MicRecorder = class {
			view = IDLE;
			listeners = /* @__PURE__ */ new Set();
			socket;
			audioContext;
			stream;
			processor;
			source;
			handlers;
			disposed = false;
			/** Return the cached immutable view. */
			getSnapshot = () => this.view;
			/** Subscribe to view replacement. */
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			/**
			* Begin one recording; replaces any in-flight session.
			* @param handlers - recognition text callbacks owned by the caller.
			*/
			async start(handlers) {
				this.cancel();
				if (this.disposed) return;
				this.handlers = handlers;
				this.publish({
					status: "connecting",
					error: null
				});
				try {
					const stream = await navigator.mediaDevices.getUserMedia({ audio: {
						channelCount: 1,
						echoCancellation: true,
						noiseSuppression: true
					} });
					if (this.disposed || this.handlers !== handlers) {
						stream.getTracks().forEach((track) => {
							track.stop();
						});
						return;
					}
					this.stream = stream;
					const audioContext = new AudioContext();
					this.audioContext = audioContext;
					const source = audioContext.createMediaStreamSource(stream);
					this.source = source;
					const processor = audioContext.createScriptProcessor(4096, 1, 1);
					this.processor = processor;
					const socket = new WebSocket(asrUrl());
					socket.binaryType = "arraybuffer";
					this.socket = socket;
					socket.onopen = () => {};
					socket.onmessage = (event) => {
						if (typeof event.data !== "string") return;
						let message;
						try {
							message = JSON.parse(event.data);
						} catch {
							return;
						}
						switch (message.type) {
							case "ready":
								if (this.view.status !== "error") this.publish({
									status: "recording",
									error: null
								});
								break;
							case "partial":
								if (message.text !== void 0) this.handlers?.onPartial(message.text);
								break;
							case "final":
								if (message.text !== void 0) this.handlers?.onFinal(message.text);
								break;
							case "error":
								console.warn(`[dsh-speech] voice input failed (${message.code ?? ""}: ${message.message ?? ""})`);
								this.publish({
									status: "error",
									error: message.message ?? message.code ?? "voice input failed"
								});
								this.cleanupCapture();
								this.handlers?.onDone();
								this.closeSocket();
								break;
							case "done":
								this.handlers?.onDone();
								this.finishView();
						}
					};
					socket.onclose = () => {
						if (this.view.status === "connecting" || this.view.status === "recording") {
							this.handlers?.onDone();
							this.finishView();
						}
					};
					socket.onerror = () => {
						if (this.view.status === "connecting" || this.view.status === "recording") {
							this.publish({
								status: "error",
								error: "voice input connection failed"
							});
							this.handlers?.onDone();
							this.cleanupCapture();
						}
					};
					processor.onaudioprocess = (event) => {
						if (socket.readyState !== WebSocket.OPEN) return;
						const pcm = toPcm16(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
						socket.send(pcm.buffer);
					};
					source.connect(processor);
					processor.connect(audioContext.destination);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.warn(`[dsh-speech] microphone unavailable: ${message}`);
					this.publish({
						status: "error",
						error: message
					});
					this.handlers?.onDone();
					this.cleanupCapture();
				}
			}
			/** Finalize: stop capture and tell the host to flush the last utterance. */
			stop() {
				this.cleanupCapture();
				if (this.socket !== void 0 && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "stop" }));
			}
			/** Abort everything (plugin unload). */
			dispose() {
				this.disposed = true;
				this.cancel();
				this.listeners.clear();
			}
			/**
			* Drop the session without the end-of-stream flush: capture and socket go,
			* callbacks detach, and no late final can land in the draft afterwards.
			*/
			cancel() {
				this.cleanupCapture();
				this.closeSocket();
				this.handlers = void 0;
				this.publish(IDLE);
			}
			finishView() {
				this.cleanupCapture();
				this.closeSocket();
				this.publish(IDLE);
			}
			closeSocket() {
				if (this.socket !== void 0) {
					this.socket.onmessage = null;
					this.socket.onclose = null;
					this.socket.onerror = null;
					this.socket.close();
					this.socket = void 0;
				}
			}
			cleanupCapture() {
				if (this.processor !== void 0) {
					this.processor.onaudioprocess = null;
					this.processor.disconnect();
					this.processor = void 0;
				}
				this.source?.disconnect();
				this.source = void 0;
				this.audioContext?.close().catch(() => {});
				this.audioContext = void 0;
				this.stream?.getTracks().forEach((track) => {
					track.stop();
				});
				this.stream = void 0;
			}
			/** Replace the view and contain subscriber failures at the boundary. */
			publish(view) {
				this.view = Object.freeze(view);
				for (const listener of this.listeners) try {
					listener();
				} catch (error) {
					console.error("[dsh-speech] subscriber threw:", error);
				}
			}
		};
		//#endregion
		//#region src/client/styles.ts
		/**
		* Plugin stylesheet, injected and removed with the plugin fiber. Mirrors the
		* shared message IconActions chrome (28px round icon buttons over the
		* semantic token palette) so the entries sit natively in both strips.
		*/
		const SPEECH_CSS = `
.dsh-speech-action,
.dsh-speech-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  border: none;
  border-radius: 28px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dsh-speech-action:hover,
.dsh-speech-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
/* The speaking message keeps the primary label color with a resting bg. */
.dsh-speech-action[data-active] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
/* The announce toggle's on state must read at a glance: success-colored icon
   on a persistent hover-like background, versus plain tertiary when off. */
.dsh-speech-toggle[data-active] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-state-success-primary);
}
.dsh-speech-toggle[data-active]:hover {
  color: var(--dsw-alias-state-success-primary);
}
.dsh-speech-mic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  border: none;
  border-radius: 28px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dsh-speech-mic:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dsh-speech-mic:disabled {
  cursor: default;
  opacity: 0.4;
}
/* Recording reads at a glance: brand-colored icon with a soft pulse. */
.dsh-speech-mic[data-recording] {
  color: var(--dsw-alias-brand-primary);
  animation: dsh-speech-mic-pulse 1.6s ease-in-out infinite;
}
@keyframes dsh-speech-mic-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
`;
		//#endregion
		//#region src/client/locales.ts
		/** `speech` namespace dictionaries. */
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"action.speak": "播报这条回复",
			"action.stop": "停止播报",
			"announce.enable": "开启自动播报",
			"announce.disable": "关闭自动播报",
			"mic.start": "语音输入",
			"mic.stop": "结束语音输入",
			"mic.unavailable": "语音输入不可用（需要云端引擎）"
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			"action.speak": "Speak this reply",
			"action.stop": "Stop speaking",
			"announce.enable": "Enable auto-announce",
			"announce.disable": "Disable auto-announce",
			"mic.start": "Voice input",
			"mic.stop": "Stop voice input",
			"mic.unavailable": "Voice input unavailable (needs a cloud engine)"
		};
		//#endregion
		//#region src/client/announce-store.ts
		/**
		* Auto-announce preference, browser-local by design: the sound plays on this
		* machine's speakers, so the toggle belongs to this browser. Persisted through
		* the runtime store engine (localStorage, memory in non-browser environments).
		* The Host settings document is deliberately not used: its client-visible
		* namespace list is closed to out-of-tree plugins today (api-proxy answers
		* `settings-not-exposed`), and a host-global toggle would make every device
		* speak at once.
		*/
		/** Versioned persistence key; bump to invalidate a stored shape change. */
		const PERSIST_KEY = "dsh.speech.announce.v1";
		/** Create the persisted announce preference store. */
		function createAnnounceStore() {
			const store = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)({ announce: "off" }, { persist: { name: PERSIST_KEY } });
			return {
				getSnapshot: () => store.getSnapshot().announce,
				subscribe: (listener) => store.subscribe(listener),
				set: (mode) => {
					store.update((draft) => {
						draft.announce = mode;
					});
				}
			};
		}
		//#endregion
		//#region src/client/index.ts
		/** Dictionary namespace owned by this plugin. */
		const NS = "speech";
		/** Required services: the slot registry, session bindings, and the copy. */
		const inject = [
			"slots",
			"sessions",
			"locale"
		];
		/**
		* Client plugin body: both slot entries and their per-session object layer.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			if (typeof window === "undefined" || typeof Audio === "undefined") return;
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-speech: dictionaries");
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-speech-plugin";
				tag.textContent = SPEECH_CSS;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, "dsh-speech: stylesheet");
			const announce = createAnnounceStore();
			const announceEnabled = () => announce.getSnapshot() === "on";
			const sessions = /* @__PURE__ */ new Map();
			const resourcesFor = (sessionId) => {
				let resources = sessions.get(sessionId);
				if (resources === void 0) {
					const controller = new SpeechController();
					const mic = new MicRecorder();
					const session = ctx.sessions.binding(sessionId)?.session;
					resources = {
						controller,
						mic,
						stopWatch: session === void 0 ? () => {} : watchSessionSpeech(session, announceEnabled, (messageId, text) => controller.toggle(messageId, text))
					};
					sessions.set(sessionId, resources);
				}
				return resources;
			};
			ctx.effect(() => () => {
				for (const { controller, mic, stopWatch } of sessions.values()) {
					stopWatch();
					controller.dispose();
					mic.dispose();
				}
				sessions.clear();
			}, "dsh-speech: session resources");
			ctx.slots.inject("conversation.chat.assistant-actions", () => {
				return ctx.slots.register({
					name: "conversation.chat.assistant-actions",
					id: "speech",
					order: 20,
					locale: NS,
					inject: (sessionId) => {
						const { controller } = resourcesFor(sessionId);
						return {
							hooks: { speech: controller },
							toggle: (messageId, text) => controller.toggle(messageId, text)
						};
					}
				}, SpeechActions);
			});
			ctx.slots.inject("conversation.session.header.utilities", () => {
				return ctx.slots.register({
					name: "conversation.session.header.utilities",
					id: "speech",
					order: 20,
					locale: NS,
					inject: (sessionId) => {
						resourcesFor(sessionId);
						return {
							hooks: { announce },
							setAnnounce: (mode) => {
								announce.set(mode);
							}
						};
					}
				}, AnnounceToggle);
			});
			ctx.slots.inject("conversation.input.right", () => {
				return ctx.slots.register({
					name: "conversation.input.right",
					id: "speech",
					order: 20,
					locale: NS,
					inject: (sessionId) => {
						const { mic } = resourcesFor(sessionId);
						return {
							hooks: { mic },
							recorder: mic
						};
					}
				}, MicButton);
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map