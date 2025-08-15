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
    this._models = []; // track model names and IDs for running checks
    this._runningInterval = null; // interval handler for running status checks
    this._connected = false; // track connection status for running checks
    this._axios = require("axios"); // HTTP client
    this._serverUrlBase = ""; // to be set on ready
    this._translations = {}; // translations
    this._enabledDatapoints = new Set(); // track both embedding and auto-change enabled datapoints
    this._processedStates = new Set(); // track processed state changes to prevent duplicates
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

      // Test OpenWebUI connection
      let openWebUIAvailable = false;
      try {
        const response = await this._axios.get(
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

              // Configure LLM-based intent detection
              this.toolServer.configureOllamaIntentDetection(this.ollamaClient);
              this.log.info(
                "[ToolServer] LLM-based intent detection configured",
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
        await this.setConnected(false);
        this.log.error(
          "[Connection] Ollama connection failed or no models available",
        );
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
    } catch (err) {
      this.log.error(`Error in onReady: ${err.message}`);
      await this.setConnected(false);
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
          "[VectorDB] Starting manual cleanup of duplicate entries...",
        );
        if (this.config.useVectorDb) {
          const qdrantUrl = `http://${this.config.vectorDbIp}:${this.config.vectorDbPort}`;
          await QdrantHelper.cleanupAllDuplicates(
            this._enabledDatapoints,
            qdrantUrl,
            "iobroker_datapoints",
            this.log,
          );
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
          const allowedDatapoints = new Set();
          for (const datapointId of this._enabledDatapoints) {
            try {
              const dpObj = await this.getForeignObjectAsync(datapointId);
              if (
                dpObj?.common?.custom?.[this.namespace]?.allowAutoChange ===
                true
              ) {
                allowedDatapoints.add(datapointId);
              }
            } catch (error) {
              this.log.debug(
                `[DatapointController] Error checking allowAutoChange for ${datapointId}: ${error.message}`,
              );
            }
          }
          this.datapointController.setAllowedDatapoints(allowedDatapoints);
          this.log.debug(
            `[DatapointController] Updated allowed datapoints: ${allowedDatapoints.size} of ${this._enabledDatapoints.size} enabled datapoints have allowAutoChange=true`,
          );
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
                if (
                  dpObj?.common?.custom?.[this.namespace]?.allowAutoChange ===
                  true
                ) {
                  allowedDatapoints.add(datapointId);
                }
              } catch (error) {
                this.log.debug(
                  `[DatapointController] Error checking allowAutoChange for ${datapointId}: ${error.message}`,
                );
              }
            }
            this.datapointController.setAllowedDatapoints(allowedDatapoints);
            this.log.debug(
              `[DatapointController] Updated allowed datapoints after removal: ${allowedDatapoints.size} of ${this._enabledDatapoints.size} enabled datapoints have allowAutoChange=true`,
            );
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
      this.log.debug(
        "[DatapointController] Controller not initialized, skipping update",
      );
      return;
    }

    const allowedDatapoints = new Set();
    this.log.debug(
      `[DatapointController] Checking ${this._enabledDatapoints.size} enabled datapoints for allowAutoChange`,
    );

    for (const datapointId of this._enabledDatapoints) {
      try {
        const dpObj = await this.getForeignObjectAsync(datapointId);
        if (dpObj?.common?.custom?.[this.namespace]?.allowAutoChange === true) {
          allowedDatapoints.add(datapointId);
          this.log.debug(
            `[DatapointController] Added ${datapointId} to allowed datapoints (allowAutoChange=true)`,
          );
        }
      } catch (error) {
        this.log.debug(
          `[DatapointController] Error checking allowAutoChange for ${datapointId}: ${error.message}`,
        );
      }
    }

    this.datapointController.setAllowedDatapoints(allowedDatapoints);
    this.log.info(
      `[DatapointController] Initialized with ${allowedDatapoints.size} allowed datapoints for automatic state changes`,
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
