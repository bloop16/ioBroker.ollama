"use strict";

const utils = require("@iobroker/adapter-core");
const QdrantHelper = require("./lib/qdrantClient");
const OllamaClient = require("./lib/ollamaClient");
const DatapointController = require("./lib/datapointController");

class ollama extends utils.Adapter {

	constructor(options) {
		super({
			...options,
			name: "ollama",
		});
		this._models = [];              // track model names and IDs for running checks
		this._runningInterval = null;   // interval handler for running status checks
		this._connected = false;        // track connection status for running checks
		this._axios = require("axios"); // HTTP client
		this._serverUrlBase = "";       // to be set on ready
		this._translations = {};        // translations
		this._enabledDatapoints = new Set(); // track both embedding and auto-change enabled datapoints
		this._processedStates = new Set(); // track processed state changes to prevent duplicates
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("objectChange", this.onObjectChange.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	translate(key) {
		if (this._translations[key]) {
			return this._translations[key];
		}
		return key;
	}

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
			this.ollamaClient.configureDatapointControl(true, this._enabledDatapoints);
		} else {
			this.ollamaClient.configureDatapointControl(false, this._enabledDatapoints);
		}

			const models = await this.ollamaClient.fetchModels();
			this.log.info(`Fetched models: ${models.join(", ")}`);
			
			// Debug: Log each model name individually
			models.forEach((model, index) => {
				this.log.debug(`[Setup] Model ${index + 1}: "${model}"`);
			});
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
	 * Creates essential ioBroker states for each Ollama model (optimized)
	 */
	async createModelStates(models) {
		await this.setObjectNotExistsAsync("models", { type: "folder", common: { name: this.translate("Ollama Models") }, native: {} });
		
		// Create vector database management state
		if (this.config.useVectorDb) {
			await this.setObjectNotExistsAsync("vectordb", { type: "channel", common: { name: this.translate("Vector Database") }, native: {} });
			await this.setObjectNotExistsAsync("vectordb.cleanup", { 
				type: "state", 
				common: { 
					name: this.translate("Clean up duplicates"), 
					type: "boolean", 
					role: "button", 
					read: true, 
					write: true, 
					def: false 
				}, 
				native: {} 
			});
		}
		
		for (const model of models) {
			const modelId = model.replace(/[^a-zA-Z0-9_]/g, "_");
			
			// Log model creation for debugging
			this.log.debug(`[Setup] Creating states for model '${model}' with ID '${modelId}'`);
			
			// Essential states only
			await this.setObjectNotExistsAsync(`models.${modelId}`, { type: "channel", common: { name: model }, native: {} });
			await this.setObjectNotExistsAsync(`models.${modelId}.response`, { type: "state", common: { name: this.translate("Response"), type: "string", role: "state", read: true, write: false }, native: {} });
			await this.setObjectNotExistsAsync(`models.${modelId}.running`, { type: "state", common: { name: this.translate("Running"), type: "boolean", role: "indicator.running", read: true, write: false, def: false }, native: {} });
			
			// Processing state to prevent multiple requests
			await this.setObjectNotExistsAsync(`models.${modelId}.processing`, { type: "state", common: { name: this.translate("Processing"), type: "boolean", role: "indicator.working", read: true, write: false, def: false }, native: {} });
			
			// Response content state (separate from formatted response)
			await this.setObjectNotExistsAsync(`models.${modelId}.content`, { type: "state", common: { name: this.translate("Response Content"), type: "string", role: "state", read: true, write: false }, native: {} });
			
			// Message states
			await this.setObjectNotExistsAsync(`models.${modelId}.messages`, { type: "channel", common: { name: this.translate("Messages") }, native: {} });
			await this.setObjectNotExistsAsync(`models.${modelId}.messages.role`, { type: "state", common: { name: this.translate("Role"), type: "string", role: "state", read: true, write: true, def: "user" }, native: {} });
			await this.setObjectNotExistsAsync(`models.${modelId}.messages.content`, { type: "state", common: { name: this.translate("Content"), type: "string", role: "state", read: true, write: true, def: "" }, native: {} });
			
			// Optional advanced states (reduced set)
			await this.setObjectNotExistsAsync(`models.${modelId}.options`, { type: "state", common: { name: this.translate("Options (JSON)"), type: "string", role: "state", read: true, write: true, def: "{}" }, native: {} });

			// Add model entry for monitoring with original name stored
			this._models.push({ name: model, id: modelId });
			
			// Store original model name in the state object for later retrieval
			await this.setObjectNotExistsAsync(`models.${modelId}.originalName`, { 
				type: "state", 
				common: { 
					name: this.translate("Original Model Name"), 
					type: "string", 
					role: "state", 
					read: true, 
					write: false, 
					def: model 
				}, 
				native: {} 
			});
			await this.setState(`models.${modelId}.originalName`, model, true);
		}
	}

	async onStateChange(id, state) {
		if (!state) return;

		try {
			// Handle vector database cleanup button
			if (id === `${this.namespace}.vectordb.cleanup` && state.val === true && !state.ack) {
				this.log.info('[VectorDB] Starting manual cleanup of duplicate entries...');
				await this.cleanupAllDuplicates();
				await this.setState('vectordb.cleanup', false, true);
				return;
			}
		// Check if this is an embedding enabled datapoint
		if (this._enabledDatapoints && this._enabledDatapoints.has(id)) {
			this.log.debug(`[VectorDB] State change for datapoint ${id}: ${state.val}`);
			
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


	async processEmbeddingDatapoint(id, state) {
		if (!this.config.useVectorDb) return;
		
		try {
			// Get the custom config for this datapoint
			const obj = await this.getForeignObjectAsync(id);
			if (!obj?.common?.custom?.[this.namespace]) return;
			
			const customConfig = obj.common.custom[this.namespace];
			
			// Create a simple deduplication key
			const stateKey = `${id}_${state.val}_${Math.floor(state.ts / 60000)}`;
			
			if (!this._processedStates) {
				this._processedStates = new Set();
			}
			
			if (this._processedStates.has(stateKey)) {
				return; // Skip duplicate
			}
			
			this._processedStates.add(stateKey);
			
			// Clean up old entries periodically
			if (this._processedStates.size > 500) {
				const entries = Array.from(this._processedStates);
				this._processedStates = new Set(entries.slice(-250));
			}
			
			// Process embedding
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
			
			// Periodic cleanup (5% chance)
			if (Math.random() < 0.05) {
				await QdrantHelper.cleanupDuplicateEntries(id, qdrantUrl, 'iobroker_datapoints', this.log);
			}
		} catch (error) {
			this.log.error(`[VectorDB] Error processing embedding for ${id}: ${error.message}`);
		}
	}

	isMessageContentState(id, state) {
		return id.startsWith(`${this.namespace}.models.`) && 
			   id.endsWith(`.messages.content`) && 
			   Boolean(state.val) && 
			   !state.ack;
	}

	/**
	 * Processes chat messages from AI models (optimized)
	 */
	async processChatMessage(id, state) {
		if (!this.ollamaClient) {
			this.log.error("OllamaClient is not initialized.");
			return;
		}

		try {
			// Extract model information
			const modelMatch = id.match(/models\.([^.]+)\.messages\.content$/);
			if (!modelMatch) {
				this.log.error(`Invalid state ID format: ${id}`);
				return;
			}
			
			const modelId = modelMatch[1];
			
			// Check if model is already processing
			const processingState = await this.getStateAsync(`models.${modelId}.processing`);
			if (processingState && processingState.val === true) {
				this.log.warn(`[API] Model ${modelId} is already processing a request. Ignoring new request.`);
				return;
			}
			
			// Set processing state
			await this.setState(`models.${modelId}.processing`, true, true);
			
			// Get the original model name from the stored state instead of converting
			const originalNameState = await this.getStateAsync(`models.${modelId}.originalName`);
			const modelName = originalNameState?.val || modelId.replace(/_/g, ':'); // fallback to old method
			
			// Log the model ID to name conversion for debugging
			this.log.debug(`[API] Using model ID '${modelId}' with original name '${modelName}'`);
			
			// Get essential states only
			const [roleState, contentState, optionsState] = await Promise.all([
				this.getStateAsync(`models.${modelId}.messages.role`),
				this.getStateAsync(`models.${modelId}.messages.content`),
				this.getStateAsync(`models.${modelId}.options`)
			]);

			// Build message object
			const messageObj = {
				role: roleState?.val || "user",
				content: contentState?.val || ""
			};

			// Process message with simplified options (force stream to false)
			const result = await this.ollamaClient.processChatMessage(modelName, messageObj, {
				options: optionsState?.val,
				stream: false // Force disable streaming
			});

			if (result) {
				// Debug: Log the full result
				this.log.debug(`[API] Full response from model ${modelName}: ${JSON.stringify(result, null, 2)}`);
				
				// Set response content in separate datapoint
				await this.setState(`models.${modelId}.content`, result.answer || "", true);
				
				// Set formatted response
				await this.setState(`models.${modelId}.response`, result.answer || "", true);
				
				// Log function call results
				if (result.toolCallResults?.length > 0) {
					this.log.info(`[AI] Model ${modelName} executed ${result.toolCallResults.length} actions`);
				}
			} else {
				this.log.error(`[API] No result received from model ${modelName}`);
			}
		} catch (error) {
			this.log.error(`Error processing chat message: ${error.message}`);
		} finally {
			// Always clear processing state
			const modelMatch = id.match(/models\.([^.]+)\.messages\.content$/);
			if (modelMatch) {
				await this.setState(`models.${modelMatch[1]}.processing`, false, true);
			}
		}
	}

	/**
	 * Handle object changes to track enabled custom config (optimized)
	 */
	async onObjectChange(id, obj) {
		try {
			// Check if object has enabled custom config
			if (obj?.common?.custom?.[this.namespace]) {
				const customConfig = obj.common.custom[this.namespace];
				
				// Track both embedding and function calling in one set
				if (customConfig.enabled === true) {
					this._enabledDatapoints.add(id);
					this.subscribeForeignStates(id);
				} else {
					this._enabledDatapoints.delete(id);
					this.unsubscribeForeignStates(id);
				}
				
				// Update OllamaClient with current enabled datapoints
				if (this.ollamaClient) {
					this.ollamaClient.updateAllowedDatapoints(this._enabledDatapoints);
				}
			} else {
				// Object deleted or custom config removed
				if (this._enabledDatapoints.has(id)) {
					this._enabledDatapoints.delete(id);
					this.unsubscribeForeignStates(id);
					if (this.ollamaClient) {
						this.ollamaClient.updateAllowedDatapoints(this._enabledDatapoints);
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
		this.log.debug("Checking for existing objects with enabled features...");
		
		try {
			// Get all objects with custom config
			const objects = await this.getObjectViewAsync('system', 'custom', {});
			
			if (objects && objects.rows) {
				for (const row of objects.rows) {
					const id = row.id;
					const customConfig = row.value;
					
					if (customConfig && customConfig[this.namespace]) {
						const features = [];
						
						// Check for embedding enabled
						if (customConfig[this.namespace].enabled === true) {
							this._enabledDatapoints.add(id);
							this.log.debug(`[VectorDB] Found existing enabled datapoint: ${id}`);
							this.subscribeForeignStates(id);
							features.push("Vector Database");
						}
						
						// Check for auto-change enabled
						if (customConfig[this.namespace].allowAutoChange === true) {
							this._enabledDatapoints.add(id);
							this.log.debug(`[FunctionCalling] Found auto-change enabled datapoint: ${id}`);
							features.push("Function Calling");
						}
						
						// Consolidated logging for startup
						if (features.length > 0) {
							this.log.info(`[Config] Datapoint ${id} configured for: ${features.join(", ")}`);
						}
					}
				}
			}
		} catch (error) {
			this.log.error(`Error checking existing objects: ${error}`);
		}
		
		this.log.info(`[AI] Found ${this._enabledDatapoints.size} datapoints with AI features enabled`);
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
		if (this._enabledDatapoints) {
			this._enabledDatapoints.clear();
		}
			
			if (this._processedStates) {
				this._processedStates.clear();
			}
			
			this.log.info('Adapter shutdown completed');
			
			callback();
		} catch (error) {
			this.log.error(`Error during adapter shutdown: ${error.message}`);
			callback();
		}
	}

	/**
	 * Clean up all duplicate entries for all embedding-enabled datapoints
	 */
	async cleanupAllDuplicates() {
		if (!this.config.useVectorDb) {
			this.log.warn('[VectorDB] Vector database is not enabled');
			return;
		}

		const qdrantUrl = `http://${this.config.vectorDbIp}:${this.config.vectorDbPort}`;
		let totalCleaned = 0;
		
		this.log.info('[VectorDB] Starting cleanup of duplicate entries for all datapoints...');
		
		for (const datapointId of this._enabledDatapoints) {
			try {
				await QdrantHelper.cleanupDuplicateEntries(datapointId, qdrantUrl, 'iobroker_datapoints', this.log);
				totalCleaned++;
			} catch (error) {
				this.log.error(`[VectorDB] Error cleaning up duplicates for ${datapointId}: ${error.message}`);
			}
		}
		
		this.log.info(`[VectorDB] Cleanup completed for ${totalCleaned} datapoints`);
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