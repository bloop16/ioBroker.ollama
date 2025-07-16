"use strict";

const utils = require("@iobroker/adapter-core");
const QdrantHelper = require("./lib/qdrantClient");
const OllamaClient = require("./lib/ollamaClient");
const DatapointController = require("./lib/datapointController");

class ollama extends utils.Adapter {

	/**
	 * Creates an instance of ollama adapter
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
		this._embeddingEnabledDatapoints = new Set(); // track embedding enabled datapoints
		this._autoChangeEnabledDatapoints = new Set(); // track auto-change enabled datapoints
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("objectChange", this.onObjectChange.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Translates text using the adapter's translation system
	 */
	translate(key) {
		if (this._translations[key]) {
			return this._translations[key];
		}
		return key;
	}

	/**
	 * Is called when databases are connected and adapter received configuration
	 * Initializes the adapter, sets up connections, and configures all components
	 */
	async onReady() {
		try {		this.log.debug(`Ollama Server IP: ${this.config.ollamaIp}`);
		this.log.debug(`Ollama Server Port: ${this.config.ollamaPort}`);

			await this.ensureInfoStates();
			
			// If Qdrant database is enabled, verify availability before proceeding
			if (this.config.useVectorDb) {
				const dbIp = this.config.vectorDbIp;
				const dbPort = this.config.vectorDbPort;
				try {
					await QdrantHelper.checkAvailability(dbIp, dbPort, this.log);
				} catch (err) {
					this.log.error(`Vector database not available: ${err.message}`);
					await this.setConnected(false);
					return;
				}
			}

			// Subscribe to all states
			this.subscribeStates("*");
			// Subscribe to all object changes for custom config changes
			this.subscribeForeignObjects("*");

			// Configure server base URL for HTTP calls
			this._serverUrlBase = `http://${this.config.ollamaIp}:${this.config.ollamaPort}`;

			// Check for existing objects with embeddingEnabled on startup
			await this.checkExistingEmbeddingEnabled();

			// Initialize OllamaClient
			this.ollamaClient = new OllamaClient(
				`http://${this.config.ollamaIp}:${this.config.ollamaPort}`,
				this.log,
				this // pass adapter for state operations
			);

			// Configure vector database if enabled
			if (this.config.useVectorDb) {
				const qdrantUrl = `http://${this.config.vectorDbIp}:${this.config.vectorDbPort}`;
				this.ollamaClient.configureVectorDb(
					true, 
					qdrantUrl, 
					this.config.embeddingModel || 'nomic-embed-text',
					this.config.maxContextResults || 5
				);
			}

			// Configure datapoint control if enabled
			if (this.config && this.config['enableDatapointControl']) {
				this.ollamaClient.configureDatapointControl(true, this._autoChangeEnabledDatapoints);
			} else {
				this.ollamaClient.configureDatapointControl(false, this._autoChangeEnabledDatapoints);
			}

			const models = await this.ollamaClient.fetchModels();
			this.log.info(`Fetched models: ${models.join(", ")}`);
			// mark connected
			await this.setConnected(true);
			
			// Create folder and states for each model tag
			await this.createModelStates(models);
			
			// Start model monitoring
			this.log.info(`Model list for monitoring: ${JSON.stringify(this._models)}`);
			const intervalMs = Number(this.config.checkOllamaModelRunning) || 0;
			this.ollamaClient.startMonitor(this._models, this.namespace, intervalMs);
			
		} catch (err) {
			this.log.error(`Error in onReady: ${err.message}`);
			await this.setConnected(false);
		}
	}

	/**
	 * Creates ioBroker states for each Ollama model
	 */
	async createModelStates(models) {
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
	}

	/**
	 * Is called if a subscribed state changes
	 * Handles state changes for chat messages and embedding-enabled datapoints
	 */
	async onStateChange(id, state) {
		if (!state) return;

		try {
			// Check if this is an embedding enabled datapoint
			if (this._embeddingEnabledDatapoints && this._embeddingEnabledDatapoints.has(id)) {
				this.log.debug(`[EmbeddingEnabled] State change for datapoint ${id}: ${JSON.stringify(state)}`);
				
				// Process embedding if vector database is enabled
				if (this.config.useVectorDb) {
					await this.processEmbeddingDatapoint(id, state);
				}
			}

			// Handle chat message inputs
			if (this.isMessageContentState(id, state)) {
				await this.processChatMessage(id, state);
			}
		} catch (error) {
			this.log.error(`Error in onStateChange for ${id}: ${error.message}`);
		}
	}

	/**
	 * Processes embedding-enabled datapoints for vector database
	 */
	async processEmbeddingDatapoint(id, state) {
		try {
			// Get the custom config for this datapoint
			const obj = await this.getForeignObjectAsync(id);
			if (obj && obj.common && obj.common.custom && obj.common.custom[this.namespace]) {
				const customConfig = obj.common.custom[this.namespace];
				
				const ollamaUrl = `http://${this.config.ollamaIp}:${this.config.ollamaPort}`;
				const qdrantUrl = `http://${this.config.vectorDbIp}:${this.config.vectorDbPort}`;
				
				await QdrantHelper.processEmbeddingEnabledDatapoint(
					id, 
					state, 
					customConfig, 
					ollamaUrl, 
					qdrantUrl, 
					this.log,
					this.config.embeddingModel || 'nomic-embed-text'
				);
			}
		} catch (error) {
			this.log.error(`[EmbeddingEnabled] Error processing embedding for ${id}: ${error}`);
		}
	}

	/**
	 * Checks if a state ID corresponds to a message content state
	 */
	isMessageContentState(id, state) {
		return id.startsWith(`${this.namespace}.models.`) && 
			   id.endsWith(`.messages.content`) && 
			   Boolean(state.val) && 
			   !state.ack;
	}

	/**
	 * Processes chat messages from AI models with function calling support
	 */
	async processChatMessage(id, state) {
		if (!this.ollamaClient) {
			this.log.error("OllamaClient is not initialized.");
			return;
		}

		try {
			// Extract model ID from state ID
			const modelMatch = id.match(/models\.([^.]+)\.messages\.content$/);
			if (!modelMatch) {
				this.log.error(`Invalid state ID format: ${id}`);
				return;
			}
			
			const modelId = modelMatch[1];
			const modelName = modelId.replace(/_/g, ':'); // Convert back to original model name format
			const userMessage = String(state.val);
			
			this.log.debug(`Processing chat message for model ${modelName}: ${userMessage}`);
			
			// Check if function calling is enabled
			if (this.config && this.config['enableDatapointControl']) {
				// Use original approach with function calling enabled
				const result = await this.ollamaClient.handleUserMessageInput(
					this.namespace, 
					id, 
					state, 
					this._models, 
					this.getStateAsync.bind(this)
				);
				
				if (result !== null) {
					const { modelId: responseModelId, answer, details } = result;
					await this.setState(`models.${responseModelId}.response`, answer, true);
					
					// Process response for function calls
					if (answer && typeof answer === 'string') {
						const functionResults = await this.ollamaClient.processResponseForDatapointChanges(answer, responseModelId);
						if (functionResults && functionResults.length > 0) {
							this.log.info(`[FunctionCalling] Model ${modelName} executed ${functionResults.length} function calls`);
							for (const funcResult of functionResults) {
								if (funcResult.success) {
									this.log.info(`[FunctionCalling] Function executed successfully: ${JSON.stringify(funcResult)}`);
								} else {
									this.log.error(`[FunctionCalling] Function execution failed: ${funcResult.error}`);
								}
							}
						}
					}
				}
				
			} else {
				// Fallback to original approach
				const result = await this.ollamaClient.handleUserMessageInput(
					this.namespace, 
					id, 
					state, 
					this._models, 
					this.getStateAsync.bind(this)
				);
				
				if (result !== null) {
					const { modelId: responseModelId, answer, details } = result;
					await this.setState(`models.${responseModelId}.response`, answer, true);
					this.log.debug(`Ollama API full response for model ${responseModelId}: ${JSON.stringify(details)}`);

					// Update response details
					const detailsPath = `models.${responseModelId}.responseDetails`;
					for (const [key, value] of Object.entries(details)) {
						await this.setObjectNotExistsAsync(`${detailsPath}.${key}`, { 
							type: "state", 
							common: { 
								name: key, 
								type: "string", 
								role: "state", 
								read: true, 
								write: false 
							}, 
							native: {} 
						});
						await this.setState(`${detailsPath}.${key}`, value !== undefined && value !== null ? String(value) : "", true);
					}
				}
			}
		} catch (error) {
			this.log.error(`Error processing chat message: ${error.message}`);
		}
	}

	/**
	 * Handle object changes to track enabled custom config
	 * Manages embedding-enabled datapoints based on configuration changes
	 */
	async onObjectChange(id, obj) {
		try {
			// Check if object has enabled custom config
			if (obj && obj.common && obj.common.custom && obj.common.custom[this.namespace]) {
				const customConfig = obj.common.custom[this.namespace];
				
				// Handle embedding enabled
				if (customConfig.enabled === true) {
					// Add to tracking set
					if (!this._embeddingEnabledDatapoints.has(id)) {
						this._embeddingEnabledDatapoints.add(id);
						this.log.debug(`[EmbeddingEnabled] Added ${id} to tracking`);
						
						// Subscribe to state changes for this datapoint
						this.subscribeForeignStates(id);
						
						// Log immediate debug for enabled datapoint
						this.log.info(`[EmbeddingEnabled] Datapoint ${id} enabled for embedding`);
					}
				} else {
					// Remove from tracking set
					if (this._embeddingEnabledDatapoints.has(id)) {
						this._embeddingEnabledDatapoints.delete(id);
						this.log.debug(`[EmbeddingEnabled] Removed ${id} from tracking`);
						
						// Unsubscribe from state changes
						this.unsubscribeForeignStates(id);
						
						this.log.info(`[EmbeddingEnabled] Datapoint ${id} disabled for embedding`);
					}
				}
				
				// Handle auto-change enabled
				if (customConfig.allowAutoChange === true) {
					if (!this._autoChangeEnabledDatapoints.has(id)) {
						this._autoChangeEnabledDatapoints.add(id);
						this.log.debug(`[AutoChange] Added ${id} to auto-change tracking`);
						this.log.info(`[AutoChange] Datapoint ${id} enabled for automatic changes`);
						
						// Update ollamaClient with new allowed datapoints
						if (this.ollamaClient) {
							this.ollamaClient.updateAllowedDatapoints(this._autoChangeEnabledDatapoints);
						}
					}
				} else {
					if (this._autoChangeEnabledDatapoints.has(id)) {
						this._autoChangeEnabledDatapoints.delete(id);
						this.log.debug(`[AutoChange] Removed ${id} from auto-change tracking`);
						this.log.info(`[AutoChange] Datapoint ${id} disabled for automatic changes`);
						
						// Update ollamaClient with new allowed datapoints
						if (this.ollamaClient) {
							this.ollamaClient.updateAllowedDatapoints(this._autoChangeEnabledDatapoints);
						}
					}
				}
			} else {
				// Object was deleted or custom config removed
				if (this._embeddingEnabledDatapoints.has(id)) {
					this._embeddingEnabledDatapoints.delete(id);
					this.log.debug(`[EmbeddingEnabled] Removed ${id} from tracking (object deleted)`);
					
					// Unsubscribe from state changes
					this.unsubscribeForeignStates(id);
					
					this.log.info(`[EmbeddingEnabled] Datapoint ${id} removed from embedding tracking`);
				}
				
				if (this._autoChangeEnabledDatapoints.has(id)) {
					this._autoChangeEnabledDatapoints.delete(id);
					this.log.debug(`[AutoChange] Removed ${id} from auto-change tracking (object deleted)`);
					this.log.info(`[AutoChange] Datapoint ${id} removed from auto-change tracking`);
					
					// Update ollamaClient with new allowed datapoints
					if (this.ollamaClient) {
						this.ollamaClient.updateAllowedDatapoints(this._autoChangeEnabledDatapoints);
					}
				}
			}
		} catch (error) {
			this.log.error(`Error in onObjectChange for ${id}: ${error.message}`);
		}
	}

	/**
	 * Check for existing objects with enabled embedding on startup
	 * Searches all objects for custom configurations with embedding enabled
	 */
	async checkExistingEmbeddingEnabled() {
		this.log.debug("Checking for existing objects with enabled...");
		
		try {
			// Get all objects with custom config
			const objects = await this.getObjectViewAsync('system', 'custom', {});
			
			if (objects && objects.rows) {
				for (const row of objects.rows) {
					const id = row.id;
					const customConfig = row.value;
					
					if (customConfig && customConfig[this.namespace]) {
						// Check for embedding enabled
						if (customConfig[this.namespace].enabled === true) {
							this._embeddingEnabledDatapoints.add(id);
							this.log.debug(`[EmbeddingEnabled] Found existing enabled datapoint: ${id}`);
							
							// Subscribe to state changes for this datapoint
							this.subscribeForeignStates(id);
						}
						
						// Check for auto-change enabled
						if (customConfig[this.namespace].allowAutoChange === true) {
							this._autoChangeEnabledDatapoints.add(id);
							this.log.debug(`[AutoChange] Found auto-change enabled datapoint: ${id}`);
						}
					}
				}
			}
		} catch (error) {
			this.log.error(`Error checking existing objects: ${error}`);
		}
		
		this.log.debug(`[EmbeddingEnabled] Found ${this._embeddingEnabledDatapoints.size} datapoints with embedding enabled`);
		this.log.debug(`[AutoChange] Found ${this._autoChangeEnabledDatapoints.size} datapoints with auto-change enabled`);
	}

	/**
	 * Ensure required info states exist
	 * Creates info folder and connection status state if they don't exist
	 */
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
	 * Set the connection status and manage monitoring
	 * Updates info.connection state and controls model monitoring
	 */
	async setConnected(connected) {
		await this.setState("info.connection", connected, true);
		this._connected = connected;
		this.log.debug(`Connection set to ${connected}`);
		
		if (!connected && this.ollamaClient) {
			this.ollamaClient.stopMonitor();
		}
	}

	/**
	 * Handle adapter unload
	 * Clean up resources and connections before adapter shutdown
	 */
	onUnload(callback) {
		try {
			// Stop all intervals
			if (this._runningInterval) {
				clearInterval(this._runningInterval);
				this._runningInterval = null;
			}
			
			// Clean up resources
			if (this.ollamaClient) {
				// Allow any pending operations to complete
				this.ollamaClient.stopMonitor();
			}
			
			// Clear tracking sets
			if (this._embeddingEnabledDatapoints) {
				this._embeddingEnabledDatapoints.clear();
			}
			
			if (this._autoChangeEnabledDatapoints) {
				this._autoChangeEnabledDatapoints.clear();
			}
			
			this.log.info('Adapter shutdown completed');
			
			callback();
		} catch (error) {
			this.log.error(`Error during adapter shutdown: ${error.message}`);
			callback();
		}
	}

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