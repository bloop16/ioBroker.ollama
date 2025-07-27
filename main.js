"use strict";

const utils = require("@iobroker/adapter-core");
const QdrantHelper = require("./lib/qdrantClient");
const OllamaClient = require("./lib/ollamaClient");
const ToolServer = require("./lib/toolServer");
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
		this.toolServer = null;         // OpenWebUI tool server instance
		this.datapointController = null; // DatapointController for function calling
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
		try {
			this.log.debug(`OpenWebUI Server: ${this.config.openWebUIIp}:${this.config.openWebUIPort}`);
			this.log.debug(`Ollama Server: ${this.config.ollamaIp}:${this.config.ollamaPort}`);
			this.log.debug(`[Startup] Adapter PID: ${process.pid}, Instance: ${this.namespace}`);

			// Check if another adapter instance is already running (development mode safety)
			try {
				const { exec } = require('child_process');
				const { promisify } = require('util');
				const execAsync = promisify(exec);
				
				const { stdout } = await execAsync(`ps aux | grep "io.ollama.0" | grep -v grep | wc -l`);
				const instanceCount = parseInt(stdout.trim());
				
				if (instanceCount > 1) {
					this.log.warn(`[Startup] Multiple adapter instances detected (${instanceCount}). This may cause conflicts.`);
					this.log.info('[Startup] This instance will continue but may share resources with other instances.');
				}
			} catch (error) {
				// Ignore process check errors - not critical
				this.log.debug(`[Startup] Process check failed: ${error.message}`);
			}

			await this.ensureInfoStates();
			
			// Configure server URLs first
			this._serverUrlBase = `http://${this.config.openWebUIIp}:${this.config.openWebUIPort}`;
			this._ollamaUrlBase = `http://${this.config.ollamaIp}:${this.config.ollamaPort}`;

			// Initialize simplified OllamaClient
			const toolServerUrl = `http://localhost:${this.config.toolServerPort || 9099}`;
			this.ollamaClient = new OllamaClient(
				this._serverUrlBase,
				this._ollamaUrlBase,
				this.log,
				this.config.openWebUIApiKey,
				(stateId, value, ack) => this.setState(stateId, value, ack),
				toolServerUrl,
				this.config
			);

			// Initialize DatapointController for function calling
			this.datapointController = new DatapointController(this, this.log);
			this.log.debug('[DatapointController] Controller initialized successfully');

			// Test OpenWebUI connection and API key if configured
			let openWebUIAvailable = false;
			if (this.config.openWebUIApiKey && this.config.openWebUIApiKey.trim() !== '') {
				openWebUIAvailable = await this.ollamaClient.testOpenWebUIConnection();
				if (!openWebUIAvailable) {
					this.log.error('OpenWebUI connection failed or API key invalid. Adapter will not be marked as connected.');
					await this.setConnected(false);
					// Don't return - continue with direct Ollama fallback
				}
			} else {
				this.log.warn('No OpenWebUI API key configured. Direct Ollama fallback will be used.');
			}
			
			// If Qdrant database is enabled, verify availability before proceeding
			if (this.config.useVectorDb) {
				const dbIp = this.config.vectorDbIp;
				const dbPort = this.config.vectorDbPort;
				try {
					await QdrantHelper.checkAvailability(dbIp, dbPort, this.log);
					this.log.info(`[VectorDB] Vector database configured: http://${dbIp}:${dbPort}`);
				} catch (err) {
					this.log.error(`Vector database not available: ${err.message}`);
					if (!openWebUIAvailable) {
						// Neither OpenWebUI nor Vector DB available
						await this.setConnected(false);
						return;
					}
				}
			}

			// Subscribe to all states
			this.subscribeStates("*");
			// Subscribe to all object changes for custom config changes
			this.subscribeForeignObjects("*");

			// Check for existing objects with embeddingEnabled on startup
			await QdrantHelper.checkExistingEmbeddingEnabled(this);

			// Initialize DatapointController with current allowed datapoints
			await this.updateDatapointControllerAllowedDatapoints();

			const models = await this.ollamaClient.fetchModels();
			this.log.info(`Fetched models: ${models.join(", ")}`);
			
			// Debug: Log each model name individually
			models.forEach((model, index) => {
				this.log.debug(`[Setup] Model ${index + 1}: "${model}"`);
			});
			
			// Only mark as connected if we have a working connection (OpenWebUI or direct Ollama)
			if (openWebUIAvailable || models.length > 0) {
				await this.setConnected(true);
				this.log.info(`[Connection] Adapter connected successfully (OpenWebUI: ${openWebUIAvailable ? 'Yes' : 'No'}, Models: ${models.length})`);
				
				// Start Tool Server only if explicitly enabled in configuration
				if (this.config.useVectorDb && this.config.enableToolServer === true) {
					// Check if another Tool Server instance is already running using the controller
					const ToolServerController = require("./lib/toolServerController");
					const controller = new ToolServerController();
					
					const isAlreadyRunning = await controller.isRunning();
					if (isAlreadyRunning) {
						const runningInstance = controller.getRunningInstance();
						this.log.info(`[ToolServer] Tool Server already running (PID: ${runningInstance?.pid}, Port: ${runningInstance?.port}) - this adapter instance will use the existing server`);
					} else {
						// No instance running, safe to start
						this.log.debug('[ToolServer] No running ToolServer detected, starting new instance...');
						await this.startToolServer();
					}
				} else if (this.config.useVectorDb && this.config.enableToolServer !== true) {
					this.log.debug('[ToolServer] Tool Server disabled in configuration - skipping startup');
				}
			} else {
				await this.setConnected(false);
				this.log.error('[Connection] Neither OpenWebUI nor direct Ollama connection working');
				return;
			}
			
			// Create folder and states for each model tag
			await this.ollamaClient.createModelStates(models, this);
			
			// Start model monitoring
			this.log.info(`Model list for monitoring: ${JSON.stringify(this._models)}`);
			
			const intervalMs = Number(this.config.checkOllamaModelRunning) || 0;
			this.ollamaClient.startMonitor(this._models, this.namespace, intervalMs);
			
		} catch (err) {
			this.log.error(`Error in onReady: ${err.message}`);
			await this.setConnected(false);
		}
	}

	async onStateChange(id, state) {
		if (!state) return;

		try {
			// Handle vector database cleanup button
			if (id === `${this.namespace}.vectordb.cleanup` && state.val === true && !state.ack) {
				this.log.info('[VectorDB] Starting manual cleanup of duplicate entries...');
				if (this.config.useVectorDb) {
					const qdrantUrl = `http://${this.config.vectorDbIp}:${this.config.vectorDbPort}`;
					await QdrantHelper.cleanupAllDuplicates(
						this._enabledDatapoints, 
						qdrantUrl, 
						'iobroker_datapoints', 
						this.log
					);
				} else {
					this.log.warn('[VectorDB] Vector database is not enabled');
				}
				await this.setState('vectordb.cleanup', false, true);
				return;
			}
			// Check if this is an embedding enabled datapoint
			if (this._enabledDatapoints && this._enabledDatapoints.has(id)) {
				this.log.debug(`[VectorDB] State change for datapoint ${id}: ${state.val}`);
				
				// Process embedding if vector database is enabled using QdrantHelper
				if (this.config.useVectorDb) {
					await QdrantHelper.processEmbeddingDatapoint(
						id, 
						state, 
						this.config, 
						this.log, 
						this._processedStates, 
						this.getForeignObjectAsync.bind(this)
					);
				}
			}

			// Handle chat message inputs
			if (id.startsWith(`${this.namespace}.models.`) && 
				id.endsWith(`.messages.content`) && 
				Boolean(state.val) && 
				!state.ack && this.ollamaClient) {
				await this.ollamaClient.processStateBasedChatMessage(id, state, this);
			}
		} catch (error) {
			this.log.error(`Error in onStateChange for ${id}: ${error.message}`);
		}
	}

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
				
				// Update DatapointController with allowed datapoints (allowAutoChange)
				if (this.datapointController) {
					const allowedDatapoints = new Set();
					for (const datapointId of this._enabledDatapoints) {
						try {
							const dpObj = await this.getForeignObjectAsync(datapointId);
							if (dpObj?.common?.custom?.[this.namespace]?.allowAutoChange === true) {
								allowedDatapoints.add(datapointId);
							}
						} catch (error) {
							this.log.debug(`[DatapointController] Error checking allowAutoChange for ${datapointId}: ${error.message}`);
						}
					}
					this.datapointController.setAllowedDatapoints(allowedDatapoints);
					this.log.debug(`[DatapointController] Updated allowed datapoints: ${allowedDatapoints.size} of ${this._enabledDatapoints.size} enabled datapoints have allowAutoChange=true`);
				}
			} else {
				// Object deleted or custom config removed
				if (this._enabledDatapoints.has(id)) {
					this._enabledDatapoints.delete(id);
					this.unsubscribeForeignStates(id);
					
					// Update DatapointController
					if (this.datapointController) {
						const allowedDatapoints = new Set();
						for (const datapointId of this._enabledDatapoints) {
							try {
								const dpObj = await this.getForeignObjectAsync(datapointId);
								if (dpObj?.common?.custom?.[this.namespace]?.allowAutoChange === true) {
									allowedDatapoints.add(datapointId);
								}
							} catch (error) {
								this.log.debug(`[DatapointController] Error checking allowAutoChange for ${datapointId}: ${error.message}`);
							}
						}
						this.datapointController.setAllowedDatapoints(allowedDatapoints);
						this.log.debug(`[DatapointController] Updated allowed datapoints after removal: ${allowedDatapoints.size} of ${this._enabledDatapoints.size} enabled datapoints have allowAutoChange=true`);
					}
				}
			}
		} catch (error) {
			this.log.error(`Error in onObjectChange for ${id}: ${error.message}`);
		}
	}

	/**
	 * Update DatapointController with currently allowed datapoints
	 * Scans all enabled datapoints and adds those with allowAutoChange=true
	 */
	async updateDatapointControllerAllowedDatapoints() {
		if (!this.datapointController) {
			this.log.debug('[DatapointController] Controller not initialized, skipping update');
			return;
		}

		const allowedDatapoints = new Set();
		this.log.debug(`[DatapointController] Checking ${this._enabledDatapoints.size} enabled datapoints for allowAutoChange`);

		for (const datapointId of this._enabledDatapoints) {
			try {
				const dpObj = await this.getForeignObjectAsync(datapointId);
				if (dpObj?.common?.custom?.[this.namespace]?.allowAutoChange === true) {
					allowedDatapoints.add(datapointId);
					this.log.debug(`[DatapointController] Added ${datapointId} to allowed datapoints (allowAutoChange=true)`);
				}
			} catch (error) {
				this.log.debug(`[DatapointController] Error checking allowAutoChange for ${datapointId}: ${error.message}`);
			}
		}

		this.datapointController.setAllowedDatapoints(allowedDatapoints);
		this.log.info(`[DatapointController] Initialized with ${allowedDatapoints.size} allowed datapoints for automatic state changes`);
	}

	/**
	 * Start the OpenWebUI Tool Server
	 * Creates and starts the tool server for RAG functionality
	 */
	async startToolServer() {
		try {
			// Check if our own instance is already running
			if (this.toolServer && this.toolServer.isRunning()) {
				this.log.debug('[ToolServer] Tool server already running in this adapter instance');
				return;
			}

			// Check if another Tool Server instance is already running system-wide
			const ToolServerController = require("./lib/toolServerController");
			const controller = new ToolServerController();
			
			const isAlreadyRunning = await controller.isRunning();
			if (isAlreadyRunning) {
				const runningInstance = controller.getRunningInstance();
				this.log.debug(`[ToolServer] Another Tool Server instance is already running (PID: ${runningInstance?.pid}, Port: ${runningInstance?.port})`);
				this.log.info('[ToolServer] Using existing Tool Server instance - no new instance needed');
				return;
			}

			this.log.info('[ToolServer] Starting new OpenWebUI Tool Server instance...');
			
			this.toolServer = new ToolServer(this.config, this.log, this._enabledDatapoints, this.datapointController);
			const started = await this.toolServer.start();
			
			if (started) {
				this.log.info('[ToolServer] OpenWebUI Tool Server started successfully');
			} else {
				this.log.warn('[ToolServer] Tool Server could not be started - continuing without tool functionality');
			}
		} catch (error) {
			if (error.code === 'EADDRINUSE') {
				this.log.warn(`[ToolServer] Port ${this.config.toolServerPort || 9099} is already in use. Tool Server disabled.`);
				this.log.info('[ToolServer] Adapter will continue running without Tool Server functionality');
			} else if (error.message.includes('already running')) {
				this.log.warn('[ToolServer] Tool Server already running - skipping duplicate instance');
				this.log.info('[ToolServer] Adapter will continue without starting additional Tool Server');
			} else {
				this.log.error(`[ToolServer] Error starting Tool Server: ${error.message}`);
			}
			// Don't re-throw the error - adapter should continue running
		}
	}

	/**
	 * Stop the OpenWebUI Tool Server
	 */
	async stopToolServer() {
		try {
			if (this.toolServer && this.toolServer.isRunning()) {
				this.log.info('[ToolServer] Stopping OpenWebUI Tool Server...');
				await this.toolServer.stop();
				this.toolServer = null;
				this.log.info('[ToolServer] Tool Server stopped');
			}
		} catch (error) {
			this.log.error(`[ToolServer] Error stopping Tool Server: ${error.message}`);
		}
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
			// Stop Tool Server first - ensure proper cleanup
			if (this.toolServer) {
				this.stopToolServer().then(() => {
					this.log.debug('[ToolServer] Tool Server stopped during adapter unload');
				}).catch(err => {
					this.log.error(`Error stopping Tool Server: ${err.message}`);
				});
			}
			
			// Additional cleanup: Ensure Tool Server controller cleanup
			try {
				const ToolServerController = require("./lib/toolServerController");
				const controller = new ToolServerController();
				controller.cleanup();
				this.log.debug('[ToolServer] Controller cleanup completed');
			} catch (cleanupError) {
				this.log.debug(`[ToolServer] Controller cleanup error (non-critical): ${cleanupError.message}`);
			}
			
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
