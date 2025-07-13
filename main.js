"use strict";

const utils = require("@iobroker/adapter-core");
const QdrantHelper = require("./lib/qdrantClient");
const OllamaClient = require("./lib/ollamaClient");

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
		if (obj) {
			this.log.debug(`Object ${id} changed: ${JSON.stringify(obj)}`);
		} else {
			this.log.debug(`Object ${id} deleted`);
		}
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
			try {
				await QdrantHelper.checkAvailability(dbIp, dbPort, this.log);
			} catch (err) {
				await this.setConnected(false);
				return;
			}
		}

		// Subscribe to all states
		this.subscribeStates("*");

		// Watch for custom embeddingEnabled changes and log debug
		QdrantHelper.watchEmbeddingEnabled(this);

		// Configure server base URL for HTTP calls
		this._serverUrlBase = `http://${this.config.ollamaIp}:${this.config.ollamaPort}`;

		// Initialize OllamaClient
		this.ollamaClient = new OllamaClient(
			`http://${this.config.ollamaIp}:${this.config.ollamaPort}`,
			this.log,
			this // pass adapter for state operations
		);

		try {
			const models = await this.ollamaClient.fetchModels();
			this.log.info(`Fetched models: ${models.join(", ")}`);
			// mark connected
			await this.setConnected(true);
			// Create folder and states for each model tag
			await this.setObjectNotExistsAsync("models", { type: "folder", common: { name: this.translate("Ollama Models") }, native: {} });
			for (const model of models) {
				const modelId = model.replace(/[^a-zA-Z0-9_]/g, "_");
				await this.setObjectNotExistsAsync(`models.${modelId}`, { type: "channel", common: { name: model }, native: {} });
				await this.setObjectNotExistsAsync(`models.${modelId}.response`, { type: "state", common: { name: this.translate("Response"), type: "string", role: "state", read: true, write: false }, native: {} });
				await this.setObjectNotExistsAsync(`models.${modelId}.running`, { type: "state", common: { name: this.translate("Running"), type: "boolean", role: "indicator.running", read: true, write: false, def: false }, native: {} });
				await this.setObjectNotExistsAsync(`models.${modelId}.expires`, { type: "state", common: { name: this.translate("Expires"), type: "string", role: "value.datetime", read: true, write: false, def: "" }, native: {} });
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
					await this.setObjectNotExistsAsync(
						`models.${modelId}.responseDetails.${key}`,
						{ type: "state", common: { name: key, type: "string", role: "state", read: true, write: false }, native: {} }
					);
				}
				// Add model entry for monitoring
				this._models.push({ name: model, id: modelId });
			}
			// Now start model-running monitor with populated model list
			// Debug: log the populated _models array
			this.log.info(`Model list for monitoring: ${JSON.stringify(this._models)}`);
			const intervalMs = Number(this.config.checkOllamaModelRunning) || 0;
			this.ollamaClient.startMonitor(this._models, this.namespace, intervalMs);
		} catch (err) {
			await this.setConnected(false);
			return;
		}
	}

	async onStateChange(id, state) {
		if (!state) return;
		// Refactored to handle null return from handleUserMessageInput.
		if (id.startsWith(`${this.namespace}.models.`) && id.endsWith(`.messages.content`) && state.val && !state.ack) {
			if (this.ollamaClient) {
				const result = await this.ollamaClient.handleUserMessageInput(this.namespace, id, state, this._models, this.getStateAsync.bind(this));
				if (result !== null) {
					const { modelId, answer, details } = result;
					await this.setState(`models.${modelId}.response`, answer, true);
					this.log.debug(`Ollama API full response for model ${modelId}: ${JSON.stringify(details)}`);

					const detailsPath = `models.${modelId}.responseDetails`;
					for (const [key, value] of Object.entries(details)) {
						await this.setObjectNotExistsAsync(`${detailsPath}.${key}`, { type: "state", common: { name: key, type: "string", role: "state", read: true, write: false }, native: {} });
						await this.setState(`${detailsPath}.${key}`, value !== undefined && value !== null ? String(value) : "", true);
					}
				}
			} else {
				this.log.error("OllamaClient is not initialized.");
			}
			return;
		} else if (id.startsWith(`${this.namespace}.models.`) && id.endsWith(`.messages.content`)) {
			// Ensure extractModelId does not return undefined.
			const modelId = this.ollamaClient ? this.ollamaClient.extractModelId(id) : null;
			if (!modelId) {
				this.log.error("Model ID could not be extracted from state ID.");
				return;
			}

			// Check for duplicate actions and streamline logic.
			const modelEntry = this._models.find(m => m.id === modelId);
			const modelName = modelEntry ? modelEntry.name : modelId;
			if (!modelName) {
				this.log.error("Model name could not be determined.");
				return;
			}

			// Add null check for 'isUserMessageInput'.
			if (this.ollamaClient && this.ollamaClient.isUserMessageInput(this.namespace, id, state)) {
				// Proceed with logic
			} else {
				this.log.error("OllamaClient or isUserMessageInput is not properly initialized.");
			}
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
		const intervalMs = Number(this.config.checkOllamaModelRunning) || 10000;
		this.log.debug(`Connection set to ${connected}. Running check interval: ${intervalMs} ms`);
		if (connected) {
			// monitor started in onReady after fetchModels
		} else {
			if (this.ollamaClient) {
				this.ollamaClient.stopMonitor();
			}
		}
	}

	/**
	 * Check which models are running via /api/ps and update states accordingly
	 */
	async checkRunning() {
		if (!this.ollamaClient) {
			this.log.error("OllamaClient is not initialized.");
			return;
		}

		try {
			const runningModels = await this.ollamaClient.checkRunningModels();
			for (const model of this._models) {
				const isRunning = runningModels.some(item => item.name === model.name || item.model === model.name || item.model === model.id);
				await this.updateRunningState(model, isRunning, runningModels);
			}
		} catch (e) {
			this.log.error(`Error checking running status: ${e}`);
		}
	}

	async updateRunningState(model, isRunning, runningModels) {
		const stateId = `models.${model.id}.running`;
		const expiresStateId = `models.${model.id}.expires`;
		const psEntry = runningModels.find(item => item.name === model.name || item.model === model.name || item.model === model.id);
		const expiresVal = psEntry?.expires_at || "";

		const prevExp = await this.getStateAsync(expiresStateId);
		if (!prevExp || prevExp.val !== expiresVal) {
			await this.setState(expiresStateId, expiresVal, true);
		}

		const prev = await this.getStateAsync(stateId);
		if (isRunning && (!prev || !prev.val)) {
			await this.setState(stateId, true, true);
		} else if (!isRunning && prev && prev.val) {
			await this.setState(stateId, false, true);
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
	 * @param {boolean} [ack]
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