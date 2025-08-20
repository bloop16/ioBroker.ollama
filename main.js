"use strict";

const utils = require("@iobroker/adapter-core");
const QdrantHelper = require("./lib/qdrantClient");
const OllamaClient = require("./lib/ollamaClient");
const ToolServer = require("./lib/toolServer");
const DatapointController = require("./lib/datapointController");
const HttpClient = require("./lib/httpClient");
const LRUCache = require("./lib/lruCache");
const ConfigValidator = require("./lib/configValidator");
const HealthMonitor = require("./lib/healthMonitor");

class ollama extends utils.Adapter {
  constructor(options) {
    super({
      ...options,
      name: "ollama",
    });
    this._models = []; // track model names and IDs for running checks
    this._runningInterval = null; // interval handler for running status checks
    this._connected = false; // track connection status for running checks
    this._httpClient = null; // Centralized HTTP client with connection pooling
    this._serverUrlBase = ""; // to be set on ready
    this._translations = {}; // translations
    this._enabledDatapoints = new Set(); // track both embedding and auto-change enabled datapoints
    this._processedStates = null; // LRU Cache for processed state changes (initialized in onReady)
    this._configValidator = null; // Configuration validator
    this._healthMonitor = null; // Health monitoring service
    this.toolServer = null; // OpenWebUI tool server instance
    this.datapointController = null; // DatapointController for function calling
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("objectChange", this.onObjectChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  translate(key) {
    // Use ioBroker's built-in translation system
    // The translations are loaded from admin/i18n/{language}/translations.json
    return this._translations[key] || key;
  }

  async onReady() {
    try {
      // Initialize configuration validator
      this._configValidator = new ConfigValidator(this.log);

      // Validate configuration early to prevent runtime errors
      const configValidation = this._configValidator.validateConfig(
        this.config,
      );
      if (!configValidation.isValid) {
        this.log.error(
          "[Adapter] Configuration validation failed. Adapter will not start.",
        );
        await this.setConnected(false);
        this.terminate ? this.terminate(11) : process.exit(11);
        return;
      }

      // Use sanitized configuration values
      const sanitizedConfig = configValidation.sanitized;
      Object.assign(this.config, sanitizedConfig);

      // Initialize HTTP client with connection pooling
      this._httpClient = HttpClient;

      // Initialize LRU cache for processed states (prevents memory leaks)
      this._processedStates = new LRUCache(1000, 300000); // 1000 items, 5min TTL

      // Initialize health monitoring
      const healthConfig = {
        ...this.config,
        healthMonitoringEnabled: this.config.healthMonitoringEnabled !== false, // Default to true if not set
        healthMonitoringPort: this.config.healthMonitoringPort || 9098,
        healthMonitoringHost: this.config.healthMonitoringHost || "127.0.0.1",
        healthCheckInterval: this.config.healthCheckInterval || 30000,
      };
      this._healthMonitor = new HealthMonitor(this.log, healthConfig);
      await this._healthMonitor.initialize(this._httpClient);

      this.log.debug(
        `OpenWebUI Server: ${this.config.openWebUIIp}:${this.config.openWebUIPort}`,
      );
      this.log.debug(
        `Ollama Server: ${this.config.ollamaIp}:${this.config.ollamaPort}`,
      );

      await this.ensureInfoStates();

      // Configure server URLs first
      this._serverUrlBase = `http://${this.config.openWebUIIp}:${this.config.openWebUIPort}`;
      this._ollamaUrlBase = `http://${this.config.ollamaIp}:${this.config.ollamaPort}`;

      // Initialize simplified OllamaClient with ioBroker i18n support
      this.ollamaClient = new OllamaClient(
        this._serverUrlBase,
        this.log,
        {
          ...this.config,
          ollamaUrl: this._ollamaUrlBase,
          toolServerUrl: undefined, // Will be set after ToolServer starts
          apiKey: this.config.openWebUIApiKey,
          setStateCallback: (stateId, value, ack) =>
            this.setState(stateId, value, ack),
        },
        this.translate.bind(this),
      );

      // Initialize DatapointController for function calling
      this.datapointController = new DatapointController(
        this,
        new Set(),
        this.log,
        this.translate.bind(this),
      );
      this.log.debug(
        "[DatapointController] Controller initialized successfully",
      );

      // Configure OllamaClient with DatapointController for Function Calling
      // Note: DatapointController Function Calling is now handled by ToolServer
      // but we keep this for direct Ollama fallback scenarios
      this.ollamaClient.configureDatapointControl(true, new Set());
      this.ollamaClient.setDatapointController(this.datapointController);
      this.log.info(
        "[OllamaClient] Configured with OpenWebUI-first architecture and ToolServer integration",
      );

      // Test OpenWebUI connection
      let openWebUIAvailable = false;
      try {
        const openWebUIClient = this._httpClient.getOpenWebUI(
          this.config.openWebUIApiKey,
        );
        const response = await openWebUIClient.get(
          `${this._serverUrlBase}/api/models`,
          {
            headers: this.config.openWebUIApiKey
              ? { Authorization: `Bearer ${this.config.openWebUIApiKey}` }
              : {},
            timeout: 5000,
          },
        );
        openWebUIAvailable = response.status === 200;
        if (openWebUIAvailable) {
          this.log.info(`[OpenWebUI] Connection successful`);
        }
      } catch (error) {
        this.log.error(`[OpenWebUI] Connection test failed: ${error.message}`);
      }

      // Test direct Ollama connection
      let ollamaAvailable = false;
      try {
        const models = await this.ollamaClient.fetchModels();
        ollamaAvailable = models.length > 0;
        if (ollamaAvailable) {
          this.log.info(
            `[Ollama] Connection successful, found ${models.length} models`,
          );
        }
      } catch (error) {
        this.log.error(`[Ollama] Connection test failed: ${error.message}`);
      }

      // If Qdrant database is enabled, verify availability before proceeding
      if (this.config.useVectorDb) {
        const dbIp = this.config.vectorDbIp;
        const dbPort = this.config.vectorDbPort;
        try {
          await QdrantHelper.checkAvailability(dbIp, dbPort, this.log);
          this.log.info(
            `[VectorDB] Vector database configured: http://${dbIp}:${dbPort}`,
          );
        } catch (err) {
          this.log.error(`Vector database not available: ${err.message}`);
          if (!openWebUIAvailable) {
            // Neither OpenWebUI nor Vector DB available
            this.log.error(
              "[Connection] Neither OpenWebUI nor Vector DB available - stopping adapter",
            );
            await this.setConnected(false);
            this.terminate ? this.terminate(12) : process.exit(12);
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

      // Only mark as connected if we have a working Ollama connection
      if (ollamaAvailable && models.length > 0) {
        await this.setConnected(true);
        this.log.info(
          `[Connection] Adapter connected successfully (Ollama: ${ollamaAvailable ? "Yes" : "No"}, Models: ${models.length})`,
        );

        // Start ToolServer now when everything is ready
        if (this.config.enableToolServer === true) {
          try {
            this.log.info("[ToolServer] Starting ToolServer...");
            this.toolServer = new ToolServer(
              this.config,
              this.log,
              this._enabledDatapoints,
              this.datapointController,
              this,
            );
            const started = await this.toolServer.start();

            if (started) {
              this.log.info("[ToolServer] ToolServer started successfully");

              // Update OllamaClient with actual ToolServer URL using configured host
              const actualPort = this.toolServer.getPort();
              const toolServerHost = this.config.toolServerHost || "127.0.0.1";
              const toolServerUrl = `http://${toolServerHost}:${actualPort}`;
              this.ollamaClient.setToolServerUrl(toolServerUrl);
              this.log.info(
                `[ToolServer] OllamaClient configured to use ToolServer at ${toolServerUrl}`,
              );

              this.log.info(
                "[ToolServer] Function calling tools configured for smart home control",
              );
            } else {
              this.log.warn(
                "[ToolServer] ToolServer could not be started - continuing without tool functionality",
              );
            }
          } catch (error) {
            if (error.message.includes("already running")) {
              this.log.warn(
                "[ToolServer] ToolServer already running - skipping duplicate instance",
              );
            } else {
              this.log.error(
                `[ToolServer] Error starting ToolServer: ${error.message}`,
              );
            }
          }
        } else {
          this.log.debug("[ToolServer] ToolServer disabled in configuration");
        }
      } else {
        this.log.error(
          "[Connection] Ollama connection failed or no models available - stopping adapter",
        );
        await this.setConnected(false);
        this.terminate ? this.terminate(13) : process.exit(13);
        return;
      }

      // Create folder and states for each model tag
      await this.ollamaClient.createModelStates(models, this);

      // Start model monitoring
      this.log.info(
        `Model list for monitoring: ${JSON.stringify(this._models)}`,
      );

      const intervalMs = Number(this.config.checkOllamaModelRunning) || 0;
      this.ollamaClient.startMonitor(
        this._models,
        this.namespace,
        intervalMs,
        this,
      );

      // Start retention cleanup timer if enabled
      this.startRetentionCleanupTimer();
    } catch (err) {
      this.log.error(`Error in onReady: ${err.message}`);
      this.log.error(`Stack trace: ${err.stack}`);
      await this.setConnected(false);

      // Terminate adapter to prevent restart loops
      this.terminate ? this.terminate(11) : process.exit(11);
      return;
    }
  }

  async onStateChange(id, state) {
    if (!state) {
      return;
    }

    try {
      // Handle vector database cleanup button
      if (
        id === `${this.namespace}.vectordb.cleanup` &&
        state.val === true &&
        !state.ack
      ) {
        this.log.info(
          "[VectorDB] Starting complete cleanup (duplicates + disabled datapoints)...",
        );
        if (this.config.useVectorDb) {
          const qdrantUrl = `http://${this.config.vectorDbIp}:${this.config.vectorDbPort}`;
          try {
            const results = await QdrantHelper.completeVectorDbCleanup(
              this._enabledDatapoints,
              qdrantUrl,
              "iobroker_datapoints",
              this.log,
            );
            this.log.info(
              `[VectorDB] Cleanup completed: ${results.disabledDatapointsRemoved} disabled datapoints removed, ${results.duplicatesCleanedDatapoints} datapoints processed for duplicates`,
            );
          } catch (error) {
            this.log.error(`[VectorDB] Cleanup failed: ${error.message}`);
          }
        } else {
          this.log.warn("[VectorDB] Vector database is not enabled");
        }
        await this.setState("vectordb.cleanup", false, true);
        return;
      }
      // Check if this is an embedding enabled datapoint
      if (this._enabledDatapoints && this._enabledDatapoints.has(id)) {
        this.log.debug(
          `[VectorDB] State change for datapoint ${id}: ${state.val}`,
        );

        // Process embedding if vector database is enabled using QdrantHelper
        if (this.config.useVectorDb) {
          await QdrantHelper.processEmbeddingDatapoint(
            id,
            state,
            this.config,
            this.log,
            this._processedStates,
            this.getForeignObjectAsync.bind(this),
          );
        }
      }

      // Handle chat message inputs
      if (
        id.startsWith(`${this.namespace}.models.`) &&
        id.endsWith(`.messages.content`) &&
        Boolean(state.val) &&
        !state.ack &&
        this.ollamaClient
      ) {
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
          const allowedDatapoints = new Set(); // For reading (all enabled)
          const writeAllowedDatapoints = new Set(); // For writing (only allowAutoChange=true)

          for (const datapointId of this._enabledDatapoints) {
            try {
              const dpObj = await this.getForeignObjectAsync(datapointId);
              const customCfg = dpObj?.common?.custom?.[this.namespace];

              // All enabled datapoints are allowed for reading
              allowedDatapoints.add(datapointId);

              // Only datapoints with allowAutoChange=true are allowed for writing
              if (customCfg?.allowAutoChange === true) {
                writeAllowedDatapoints.add(datapointId);
                this.log.debug(
                  `[DatapointController] Added ${datapointId} to write-allowed datapoints (allowAutoChange=true)`,
                );
              }
            } catch (error) {
              this.log.debug(
                `[DatapointController] Error checking allowAutoChange for ${datapointId}: ${error.message}`,
              );
            }
          }

          // Set both read and write permissions
          this.datapointController.setAllowedDatapoints(allowedDatapoints);
          this.datapointController.setWriteAllowedDatapoints(
            writeAllowedDatapoints,
          );

          // Update OllamaClient with readable datapoints for Function Calling
          if (
            this.ollamaClient &&
            this.ollamaClient.configureDatapointControl
          ) {
            this.ollamaClient.configureDatapointControl(
              true,
              allowedDatapoints,
            );
          }

          this.log.info(
            `[DatapointController] Updated permissions: ${allowedDatapoints.size} readable datapoints, ${writeAllowedDatapoints.size} writable datapoints (allowAutoChange=true)`,
          );
        }
      } else {
        // Object deleted or custom config removed
        if (this._enabledDatapoints.has(id)) {
          this._enabledDatapoints.delete(id);
          this.unsubscribeForeignStates(id);

          // Update DatapointController after removal
          if (this.datapointController) {
            await this.updateDatapointControllerAllowedDatapoints();
          }
        }
      }
    } catch (error) {
      this.log.error(`Error in onObjectChange for ${id}: ${error.message}`);
    }
  }

  /**
   * Update DatapointController with currently allowed datapoints
   * Makes all VectorDB-enabled datapoints available for getState (reading)
   * Only datapoints with allowAutoChange=true are available for setState (writing)
   */
  async updateDatapointControllerAllowedDatapoints() {
    if (!this.datapointController) {
      this.log.debug(
        "[DatapointController] Controller not initialized, skipping update",
      );
      return;
    }

    // All VectorDB-enabled datapoints are allowed for reading (getState)
    const allowedDatapoints = new Set(this._enabledDatapoints);

    // Separate set for write-allowed datapoints (setState)
    const writeAllowedDatapoints = new Set();

    this.log.debug(
      `[DatapointController] Processing ${this._enabledDatapoints.size} enabled datapoints`,
    );

    for (const datapointId of this._enabledDatapoints) {
      try {
        const dpObj = await this.getForeignObjectAsync(datapointId);
        if (dpObj?.common?.custom?.[this.namespace]?.allowAutoChange === true) {
          writeAllowedDatapoints.add(datapointId);
          this.log.debug(
            `[DatapointController] Added ${datapointId} to write-allowed datapoints (allowAutoChange=true)`,
          );
        }
      } catch (error) {
        this.log.debug(
          `[DatapointController] Error checking allowAutoChange for ${datapointId}: ${error.message}`,
        );
      }
    }

    // Set all enabled datapoints as readable
    this.datapointController.setAllowedDatapoints(allowedDatapoints);
    this.datapointController.setWriteAllowedDatapoints(writeAllowedDatapoints);

    // Update OllamaClient with all enabled datapoints for Function Calling
    if (this.ollamaClient && this.ollamaClient.configureDatapointControl) {
      this.ollamaClient.configureDatapointControl(true, allowedDatapoints);
      this.log.debug(
        `[OllamaClient] Updated Function Calling with ${allowedDatapoints.size} readable datapoints`,
      );
    }

    this.log.info(
      `[DatapointController] Initialized with ${allowedDatapoints.size} readable datapoints (including VectorDB-enabled), ${writeAllowedDatapoints.size} writable datapoints (allowAutoChange=true only)`,
    );
  }

  /**
   * Ensure required info states exist
   * Creates info folder and connection status state if they don't exist
   */
  async ensureInfoStates() {
    await this.setObjectNotExistsAsync("info", {
      type: "folder",
      common: { name: this.translate("Info") },
      native: {},
    });
    await this.setObjectNotExistsAsync("info.connection", {
      type: "state",
      common: {
        name: this.translate("Connection status"),
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false,
      },
      native: {},
    });
  }

  /**
   * Set the connection status and manage monitoring
   * Updates info.connection state and controls model monitoring
   *
   * @param {boolean} connected - Connection status
   */
  async setConnected(connected) {
    await this.setState("info.connection", connected, true);
    this._connected = connected;
    this.log.debug(`Connection set to ${connected}`);

    if (!connected && this.ollamaClient) {
      this.ollamaClient.stopMonitor(this);
    }
  }

  /**
   * Start retention cleanup timer if vector database and retention policy are enabled
   */
  startRetentionCleanupTimer() {
    if (!this.config.useVectorDb || !this.config.retentionEnabled) {
      this.log.debug(
        "[RetentionCleanup] Vector database or retention policy disabled - skipping timer",
      );
      return;
    }

    const intervalHours = this.config.retentionCleanupInterval || 24;
    const intervalMs = intervalHours * 60 * 60 * 1000; // Convert hours to milliseconds

    this.log.info(
      `[RetentionCleanup] Starting retention cleanup timer (every ${intervalHours} hours)`,
    );

    // Run initial cleanup after 5 minutes to avoid startup congestion
    this._retentionInitialTimeout = this.setTimeout(
      () => {
        this.runRetentionCleanup();
      },
      5 * 60 * 1000,
    );

    // Schedule regular cleanup
    this._retentionCleanupInterval = this.setInterval(() => {
      this.runRetentionCleanup();
    }, intervalMs);
  }

  /**
   * Execute retention cleanup for all enabled datapoints
   */
  async runRetentionCleanup() {
    if (
      !this.config.useVectorDb ||
      !this.config.retentionEnabled ||
      !this._enabledDatapoints
    ) {
      this.log.debug(
        "[RetentionCleanup] Skipping cleanup - requirements not met",
      );
      return;
    }

    try {
      this.log.info("[RetentionCleanup] Starting retention cleanup...");

      const qdrantUrl = `http://${this.config.vectorDbIp}:${this.config.vectorDbPort}`;
      const collectionName =
        this.config.vectorDbCollection || "iobroker_datapoints";

      const retentionConfig = {
        retentionEnabled: this.config.retentionEnabled,
        retentionDays: this.config.retentionDays || 30,
        retentionMaxEntries: this.config.retentionMaxEntries || 100,
      };

      const QdrantHelper = require("./lib/qdrantClient");
      const result = await QdrantHelper.runRetentionCleanup(
        this._enabledDatapoints,
        qdrantUrl,
        collectionName,
        retentionConfig,
        this.log,
      );

      this.log.info(
        `[RetentionCleanup] Cleanup completed: processed ${result.processed} datapoints, removed ${result.removed} entries`,
      );

      // Update state object for monitoring
      await this.setStateAsync("info.retentionCleanup", {
        val: JSON.stringify({
          lastRun: new Date().toISOString(),
          processed: result.processed,
          removed: result.removed,
        }),
        ack: true,
      });
    } catch (error) {
      this.log.error(
        `[RetentionCleanup] Error during retention cleanup: ${error.message}`,
      );
    }
  }

  /**
   * Handle adapter unload
   * Clean up resources and connections before adapter shutdown
   *
   * @param {Function} callback - Callback function to call when unload is complete
   */
  onUnload(callback) {
    try {
      // Stop ToolServer (without Controller/Lockfile)
      if (this.toolServer && this.toolServer.isServerRunning()) {
        this.toolServer
          .stop()
          .then(() => {
            this._finishUnload(callback);
          })
          .catch((err) => {
            this.log.error(`Error stopping ToolServer: ${err.message}`);
            this._finishUnload(callback);
          });
      } else {
        this._finishUnload(callback);
      }
    } catch (error) {
      this.log.error(`Error during adapter shutdown: ${error.message}`);
      callback();
    }
  }

  /**
   * Finish the unload process after ToolServer cleanup
   *
   * @param {Function} callback - Callback function to call when cleanup is complete
   */
  _finishUnload(callback) {
    try {
      // Stop all intervals
      if (this._runningInterval) {
        this.clearInterval(this._runningInterval);
        this._runningInterval = null;
      }

      // Stop retention cleanup timers
      if (this._retentionCleanupInterval) {
        this.clearInterval(this._retentionCleanupInterval);
        this._retentionCleanupInterval = null;
      }

      if (this._retentionInitialTimeout) {
        this.clearTimeout(this._retentionInitialTimeout);
        this._retentionInitialTimeout = null;
      }

      // Clean up resources
      if (this.ollamaClient) {
        // Allow any pending operations to complete
        this.ollamaClient.stopMonitor(this);
      }

      // Clear tracking sets
      if (this._enabledDatapoints) {
        this._enabledDatapoints.clear();
      }

      if (this._processedStates) {
        this._processedStates.clear();
      }

      // Shutdown health monitoring
      if (this._healthMonitor) {
        this._healthMonitor.shutdown().catch((error) => {
          this.log.error(
            `Error shutting down health monitor: ${error.message}`,
          );
        });
      }

      this.log.info("Adapter shutdown completed");

      callback();
    } catch (error) {
      this.log.error(`Error during final cleanup: ${error.message}`);
      callback();
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options] - Optional adapter configuration options
   */
  module.exports = (options) => new ollama(options);
} else {
  // otherwise start the instance directly
  new ollama();
}
