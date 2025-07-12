"use strict";

const utils = require("@iobroker/adapter-core");
const { QdrantClient } = require("@qdrant/qdrant-js");

class ollama extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: "ollama",
		});
		this._subscribedStates = new Set();
		this._models = [];              // track model names and IDs for running checks
		this._runningInterval = null;   // interval handler for running status checks
		this._connected = false;        // track connection status for running checks
		this._axios = require("axios"); // HTTP client
		this._serverUrlBase = "";       // to be set on ready
		this._translations = {};        // translations
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("objectChange", this.onObjectChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Handles object changes.
	 * @param {string} id
	 * @param {ioBroker.Object | null | undefined} obj
	 */
	onObjectChange(id, obj) {
		this.log.info(`[OBJECT CHANGE] ${id}: ${JSON.stringify(obj)}`);
		// Add your object change handling logic here
	}

	/**
	 * translates text
	 * @param {string} key
	 */
	translate(key) {
		if (this._translations[key]) {
			return this._translations[key];
		}
		return key;
	}

	async onReady() {
		this.log.info("Ollama Server IP: " + this.config.ollamaIp);
		this.log.info("Ollama Server Port: " + this.config.ollamaPort);

		await this.ensureInfoStates();
		// If Qdrant database is enabled, verify availability before proceeding
		if (this.config.useVectorDb) {
			const dbIp = this.config.vectorDbIp;
			const dbPort = this.config.vectorDbPort;
			// use qdrant-js client for health check
			const client = new QdrantClient({ url: `http://${dbIp}:${dbPort}` });
			this.log.info(`Checking Vector DB availability via Qdrant client at ${dbIp}:${dbPort}`);
			try {
				// perform a simple operation via qdrant-js client to verify connectivity
				// simple call to fetch collections to verify connectivity
				await client.getCollections();
				this.log.info('Vector DB is available');
			} catch (err) {
				this.log.error(`Error connecting to Vector DB: ${err}`);
				await this.setConnected(false);
				return;
			}
		}

		// Subscribe to all states
		this.subscribeStates("*");

		// Configure server base URL for HTTP calls
		this._serverUrlBase = `http://${this.config.ollamaIp}:${this.config.ollamaPort}`;

		try {
			const resp = await this._axios.get(`${this._serverUrlBase}/api/tags`, { timeout: 15000 });
			if (resp.status === 200) {
				let models;
				if (Array.isArray(resp.data)) {
					models = resp.data;
				} else if (resp.data && Array.isArray(resp.data.tags)) {
					models = resp.data.tags;
				} else if (resp.data && Array.isArray(resp.data.models)) {
					models = resp.data.models.map(item => item.name || item.model);
				} else {
					this.log.error(`Unexpected data structure from /api/tags: ${JSON.stringify(resp.data)}`);
					await this.setConnected(false);
					return;
				}
				this.log.info(`Fetched models: ${models.join(", ")}`);
				await this.setConnected(true);
				// Create folder and states for each model tag
				await this.setObjectNotExistsAsync("models", { type: "folder", common: { name: this.translate("Ollama Models") }, native: {} });
				for (const model of models) {
					const modelId = model.replace(/[^a-zA-Z0-9_]/g, "_");
					await this.setObjectNotExistsAsync(`models.${modelId}`, { type: "channel", common: { name: model }, native: {} });
					await this.setObjectNotExistsAsync(`models.${modelId}.response`, { type: "state", common: { name: this.translate("Response"), type: "string", role: "state", read: true, write: false }, native: {} });
					await this.setObjectNotExistsAsync(`models.${modelId}.running`, { type: "state", common: { name: this.translate("Running"), type: "boolean", role: "indicator.running", read: true, write: false, def: false }, native: {} });
					await this.setObjectNotExistsAsync(`models.${modelId}.expires`, { type: "state", common: { name: this.translate("Expires"), type: "string", role: "value", read: true, write: false, def: "" }, native: {}});
					await this.setObjectNotExistsAsync(`models.${modelId}.messages`, { type: "channel", common: { name: this.translate("Messages") }, native: {} });
					await this.setObjectNotExistsAsync(`models.${modelId}.messages.role`, { type: "state", common: { name: this.translate("Role"), type: "string", role: "state", read: true, write: true, def: "user" }, native: {} });
					await this.setObjectNotExistsAsync(`models.${modelId}.messages.content`, { type: "state", common: { name: this.translate("Content"), type: "string", role: "state", read: true, write: true, def: "" }, native: {} });
					await this.setObjectNotExistsAsync(`models.${modelId}.messages.images`, { type: "state", common: { name: this.translate("Images (JSON Array)"), type: "string", role: "state", read: true, write: true, def: "[]" }, native: {} });
					await this.setObjectNotExistsAsync(`models.${modelId}.messages.tool_calls`, { type: "state", common: { name: this.translate("Tool Calls (JSON Array)"), type: "string", role: "state", read: true, write: true, def: "[]" }, native: {} });
					await this.setObjectNotExistsAsync(`models.${modelId}.stream`, { type: "state", common: { name: this.translate("Stream"), type: "boolean", role: "state", read: true, write: true, def: false }, native: {} });
					await this.setObjectNotExistsAsync(`models.${modelId}.think`, { type: "state", common: { name: this.translate("Think"), type: "boolean", role: "state", read: true, write: true, def: false }, native: {} });
					await this.setObjectNotExistsAsync(`models.${modelId}.tools`, { type: "state", common: { name: this.translate("Tools (JSON)"), type: "string", role: "state", read: true, write: true, def: "[]" }, native: {} });
					await this.setObjectNotExistsAsync(`models.${modelId}.keep_alive`, { type: "state", common: { name: this.translate("Keep Alive"), type: "string", role: "state", read: true, write: true, def: "5m" }, native: {} });
					await this.setObjectNotExistsAsync(`models.${modelId}.format`, { type: "state", common: { name: this.translate("Format ('json' or JSON object)"), type: "string", role: "state", read: true, write: true, def: "" }, native: {} });
					await this.setObjectNotExistsAsync(`models.${modelId}.options`, { type: "state", common: { name: this.translate("Options (JSON)"), type: "string", role: "state", read: true, write: true, def: "{}" }, native: {} });

					// Create response details channel and states
					await this.setObjectNotExistsAsync(`models.${modelId}.responseDetails`, { type: "channel", common: { name: "Response Details" }, native: {} });
					const detailsKeys = [
						"created_at",
						"role",
						"content",
						"total_duration",
						"load_duration",
						"prompt_eval_count",
						"prompt_eval_duration",
						"eval_count",
						"eval_duration"
					];
					for (const key of detailsKeys) {
						await this.setObjectNotExistsAsync(`models.${modelId}.responseDetails.${key}`, { type: "state", common: { name: key, type: "string", role: "state", read: true, write: false }, native: {} });
					}

					this._models.push({ name: model, id: modelId });
				}
			} else {
				this.log.error(`Unexpected status from /api/tags: ${resp.status}`);
				await this.setConnected(false);
				return;
			}
		} catch (err) {
			this.log.error(`Error fetching models from /api/tags: ${err}`);
			await this.setConnected(false);
			return;
		}
	}

	async onStateChange(id, state) {
		if (!state) return;
		// Trigger on user message content input
		if (id.startsWith(`${this.namespace}.models.`) && id.endsWith(`.messages.content`) && state.val && !state.ack) {
			const parts = id.split(".");
			const modelId = parts[parts.length - 3];
			this.log.info(`Detected message update for model ${modelId}`);
			const entry = this._models.find(m => m.id === modelId);
			const modelName = entry ? entry.name : modelId;

			// Build messages array from individual message datapoints
			const [roleState, contentState, imagesState, toolCallsState] = await Promise.all([
				this.getStateAsync(`models.${modelId}.messages.role`),
				this.getStateAsync(`models.${modelId}.messages.content`),
				this.getStateAsync(`models.${modelId}.messages.images`),
				this.getStateAsync(`models.${modelId}.messages.tool_calls`),
			]);

			const messageObj = {
				role: roleState?.val || "user",
				content: contentState?.val || ""
			};

			if (imagesState?.val && imagesState.val !== "[]") {
				try { messageObj.images = JSON.parse(String(imagesState.val)); } catch (e) { this.log.error(`Invalid JSON in messages.images for ${modelId}: ${e}`); }
			}
			if (toolCallsState?.val && toolCallsState.val !== "[]") {
				try { messageObj.tool_calls = JSON.parse(String(toolCallsState.val)); } catch (e) { this.log.error(`Invalid JSON in messages.tool_calls for ${modelId}: ${e}`); }
			}

			const messages = [messageObj];
			const payload = { model: modelName, messages };

			// Fetch optional parameters
			const [toolsState, thinkState, formatState, optionsState, streamState, keepAliveState] = await Promise.all([
				this.getStateAsync(`models.${modelId}.tools`),
				this.getStateAsync(`models.${modelId}.think`),
				this.getStateAsync(`models.${modelId}.format`),
				this.getStateAsync(`models.${modelId}.options`),
				this.getStateAsync(`models.${modelId}.stream`),
				this.getStateAsync(`models.${modelId}.keep_alive`),
			]);

			if (toolsState?.val && toolsState.val !== "[]") {
				try { payload.tools = JSON.parse(String(toolsState.val)); } catch (e) { this.log.error(`Invalid JSON in tools for ${modelId}: ${e}`); }
			}
			if (thinkState) payload.think = !!thinkState.val;
			if (formatState?.val) {
				const formatVal = String(formatState.val);
				if (formatVal === "json") {
					payload.format = "json";
				} else if (formatVal && formatVal !== "{}") {
					try { payload.format = JSON.parse(formatVal); } catch (e) { this.log.error(`Invalid JSON in format for ${modelId}: ${e}`); }
				}
			}
			if (optionsState?.val && optionsState.val !== "{}") {
				try { payload.options = JSON.parse(String(optionsState.val)); } catch (e) { this.log.error(`Invalid JSON in options for ${modelId}: ${e}`); }
			}
			if (streamState) payload.stream = !!streamState.val;
			if (keepAliveState?.val) {
				payload.keep_alive = String(keepAliveState.val);
			}

			this.log.debug(`Chat payload for model ${modelId}: ${JSON.stringify(payload)}`);
			try {
				const resp = await this._axios.post(
					`${this._serverUrlBase}/api/chat`,
					payload,
					{ headers: { "Content-Type": "application/json" }, timeout: 60000 }
				);
				// Extract response
				let answer;
				if (resp.data && typeof resp.data === "object") {
					if (resp.data.response) {
						answer = resp.data.response;
					} else if (resp.data.message && resp.data.message.content) {
						answer = resp.data.message.content;
					} else {
						answer = JSON.stringify(resp.data);
					}
				} else {
					// Handle streaming case where data is not a single JSON object
					answer = resp.data;
				}

				await this.setState(`models.${modelId}.response`, answer, true);

				this.log.debug(`Ollama API full response for model ${modelId}: ${JSON.stringify(resp.data)}`);

				// Extrahiere Details und speichere sie in eigenen States
				const detailsPath = `models.${modelId}.responseDetails`;
				await this.setObjectNotExistsAsync(detailsPath, { type: "channel", common: { name: "Response Details" }, native: {} });
				const details = {
					created_at: resp.data.created_at,
					role: resp.data.message?.role,
					content: resp.data.message?.content,
					total_duration: resp.data.total_duration,
					load_duration: resp.data.load_duration,
					prompt_eval_count: resp.data.prompt_eval_count,
					prompt_eval_duration: resp.data.prompt_eval_duration,
					eval_count: resp.data.eval_count,
					eval_duration: resp.data.eval_duration
				};
				for (const [key, value] of Object.entries(details)) {
					await this.setObjectNotExistsAsync(`${detailsPath}.${key}`, { type: "state", common: { name: key, type: "string", role: "state", read: true, write: false }, native: {} });
					await this.setState(`${detailsPath}.${key}`, value !== undefined && value !== null ? String(value) : "", true);
				}
			} catch (e) {
				this.log.error(`Error generating response for model ${modelId}: ${e}`);
				if (e.response && e.response.data) {
					this.log.error(`Response body: ${JSON.stringify(e.response.data)}`);
				}
			}
			return;
		}
	}

	async ensureInfoStates() {
		await this.setObjectNotExistsAsync("info", {
			type: "folder",
			common: { name: this.translate("Info") },
			native: {}
		});
		await this.setObjectNotExistsAsync("info.connection", {
			type: "state",
			common: {
				name: this.translate("Connection status"),
				type: "boolean",
				role: "indicator.connected",
				read: true,
				write: false,
				def: false
			},
			native: {}
		});
	}

	/**
	 * Sets the info.connection state.
	 * @param {boolean} connected
	 */
	async setConnected(connected) {
		await this.setState("info.connection", connected, true);
		this._connected = connected;
		const intervalMs = this.config.checkOllamaModelRunning;
		if (connected && intervalMs > 0) {
			this.log.info(`Starting running-status checks every ${intervalMs} ms`);
			if (this._runningInterval) clearInterval(this._runningInterval);
			// schedule checks and run initial
			this._runningInterval = setInterval(() => this.checkRunning(), intervalMs);
			this.checkRunning();
		} else if (!connected && this._runningInterval) {
			clearInterval(this._runningInterval);
			this._runningInterval = null;
			this.log.info("Stopped running-status checks");
		}
	}

	/**
	 * Check which models are running via /api/ps and update states accordingly
	 */
	async checkRunning() {
		try {
			const resp = await this._axios.get(this._serverUrlBase + "/api/ps", { timeout: 15000 });
			const list = Array.isArray(resp.data.models) ? resp.data.models
				: Array.isArray(resp.data) ? resp.data
					: Array.isArray(resp.data.processes) ? resp.data.processes
						: [];
			this.log.debug(`Running models: ${list.map(item => item.name).join(", ")}`);
			for (const m of this._models) {
				const running = list.some(item => item.name === m.name || item.model === m.name || item.model === m.id);
				const stateId = `models.${m.id}.running`;
				// Update expires state
				const psEntry = list.find(item => item.name === m.name || item.model === m.name || item.model === m.id);
				const expiresVal = psEntry && psEntry.expires_at ? psEntry.expires_at : "";
				const expStateId = `models.${m.id}.expires`;
				const prevExp = await this.getStateAsync(expStateId);
				if (!prevExp || prevExp.val !== expiresVal) {
					await this.setState(expStateId, expiresVal, true);
				}
				const prev = await this.getStateAsync(stateId);
				if (running && (!prev || !prev.val)) {
					await this.setState(stateId, true, true);
				} else if (!running && prev && prev.val) {
					await this.setState(stateId, false, true);
				}
			}
		} catch (e) {
			this.log.error(`Error checking running status: ${e}`);
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		if (this._runningInterval) clearInterval(this._runningInterval);
		callback();
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new ollama(options);
} else {
	// otherwise start the instance directly
	new ollama();
}