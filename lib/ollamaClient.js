"use strict";

const axios = require("axios");

/**
 * OllamaClient handles interactions with Ollama and OpenWebUI APIs
 * Provides chat completion, model management, and datapoint control features
 */
class OllamaClient {
  /**
   * @param {string} openWebUIUrl - OpenWebUI server URL for chat API
   * @param {object} logger - Logger instance for debug and error messages
   * @param {object} [config] - Adapter configuration
   * @param {Function} [translateFn] - ioBroker translation function
   */
  constructor(openWebUIUrl, logger, config, translateFn) {
    this._openWebUIUrl = openWebUIUrl;
    this._ollamaUrl =
      config?.ollamaUrl ||
      `http://${config?.ollamaIp || "127.0.0.1"}:${config?.ollamaPort || 11434}`;
    this._toolServerUrl = config?.toolServerUrl || `http://127.0.0.1:9100`; // Use default from jsonConfig.json
    this._axios = axios;
    this.log = logger;
    this.translate = translateFn || ((key) => key);
    this._apiKey = config?.apiKey || "";
    this._monitorInterval = null;
    this._setStateCallback = config?.setStateCallback;
    this.config = config || {};
    this.chatModel = config?.toolServerChatModel || "llama3.2"; // Default chat model for LLM operations

    // DatapointController integration
    this._datapointController = null;
    this._datapointControlEnabled = false;

    const logMessage = this.translate("general_initialized").replace(
      "{{component}}",
      "OllamaClient",
    );
    if (this.log && typeof this.log.debug === "function") {
      this.log.debug(logMessage);
    } else if (this.log && typeof this.log.info === "function") {
      this.log.info(logMessage);
    } else {
      console.log(logMessage);
    }
  }

  /**
   * Update the ToolServer URL after ToolServer has started
   *
   * @param {string} toolServerUrl - New ToolServer URL
   */
  setToolServerUrl(toolServerUrl) {
    this._toolServerUrl = toolServerUrl;
    if (this.log.debug) {
      this.log.debug(
        this.translate("server_updated").replace("{{url}}", toolServerUrl),
      );
    } else {
      this.log.info(
        this.translate("server_updated").replace("{{url}}", toolServerUrl),
      );
    }
  }

  /**
   * Configure datapoint control with ioBroker integration
   *
   * @param {boolean} enabled - Enable datapoint control
   * @param {Set} allowedDatapoints - Set of allowed datapoint IDs
   * @param {object} adapter - ioBroker adapter instance (optional, for testing can be null)
   */
  configureDatapointControl(enabled, allowedDatapoints, adapter = null) {
    this._datapointControlEnabled = enabled;

    if (enabled) {
      const DatapointController = require("./datapointController");

      // Create mock adapter if none provided (for testing)
      const mockAdapter = adapter || {
        getForeignStateAsync: async (_id) => ({ val: "test", ts: Date.now() }),
        getObjectAsync: async (_id) => ({ common: { type: "boolean" } }),
        setStateAsync: async (_id, _val) => true,
      };

      this._datapointController = new DatapointController(
        mockAdapter,
        allowedDatapoints,
        this.log,
        this.translate,
      );

      this.log.info(this.translate("datapoint_control_enabled"));
    } else {
      this._datapointController = null;
      this.log.info(this.translate("datapoint_control_disabled"));
    }
  }

  /**
   * Fetch available models directly from Ollama API
   */
  async fetchModels() {
    try {
      this.log.debug(
        `[API] Fetching models from Ollama: ${this._ollamaUrl}/api/tags`,
      );
      const resp = await this._axios.get(`${this._ollamaUrl}/api/tags`, {
        timeout: 10000,
      });

      if (resp.data && resp.data.models) {
        const models = resp.data.models.map((model) => model.name);
        this.log.info(
          `[Ollama] Successfully fetched ${models.length} models: ${models.join(", ")}`,
        );
        return models;
      }

      this.log.error("[Ollama] Unexpected response format from Ollama API");
      return [];
    } catch (error) {
      if (error.response) {
        this.log.error(
          `[Ollama] HTTP Error ${error.response.status}: ${error.response.statusText || "Unknown"}`,
        );
      } else if (error.code === "ECONNREFUSED") {
        this.log.error(
          `[Ollama] Connection refused - Is Ollama running on ${this._ollamaUrl}?`,
        );
      } else {
        this.log.error(`[Ollama] Error fetching models: ${error.message}`);
      }

      return [];
    }
  }

  /**
   * Check running models via direct Ollama connection
   */
  async checkRunningModels() {
    try {
      // Use direct Ollama connection for status monitoring
      const resp = await this._axios.get(`${this._ollamaUrl}/api/ps`, {
        timeout: 10000,
      });
      return resp.data.models || [];
    } catch (error) {
      this.log.debug(
        `[Monitor] Error checking running models: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Process chat message via Tool Server with OpenWebUI as primary backend
   *
   * @param {string} modelName - Name of the LLM model to use
   * @param {object} messageObj - Message object with content and role
   * @param {object} options - Optional parameters for the request
   */
  async processChatMessage(modelName, messageObj, options = {}) {
    if (!modelName || !messageObj || !messageObj.content) {
      this.log.error(`[API] Invalid inputs for model ${modelName}`);
      return null;
    }

    this.log.debug(
      `[API] Processing chat via Tool Server for model: "${modelName}"`,
    );

    try {
      // Check if Tool Server is available
      const toolServerAvailable = await this._checkToolServerAvailability();

      if (toolServerAvailable) {
        // Use Tool Server for complete chat processing with RAG
        return await this._processChatViaToolServer(
          modelName,
          messageObj,
          options,
        );
      }
      // No fallback to direct Ollama - OpenWebUI only
      this.log.error(
        `[API] Tool Server not available - OpenWebUI connection required for reliable results`,
      );
      throw new Error(
        "Tool Server unavailable - cannot process chat request without RAG integration",
      );
    } catch (error) {
      this.log.error(`Error processing chat message: ${error.message}`);
      return null;
    }
  }

  /**
   * Process chat via Tool Server with RAG integration
   *
   * @param {string} modelName - Name of the LLM model to use
   * @param {object} messageObj - Message object with content and role
   * @param {object} options - Optional parameters for the request
   */
  async _processChatViaToolServer(modelName, messageObj, options = {}) {
    try {
      const messages = [
        {
          role: messageObj.role || "user",
          content: messageObj.content,
        },
      ];

      const payload = {
        model: modelName,
        messages: messages,
        temperature: this.config?.temperature ?? 0.7,
        max_tokens: this.config?.maxTokens ?? 2048,
        use_rag: true, // Always use RAG for enhanced context
      };

      // Add custom options if provided
      if (
        options.options &&
        typeof options.options === "string" &&
        options.options !== "{}"
      ) {
        try {
          const customOptions = JSON.parse(options.options);
          Object.assign(payload, customOptions);
        } catch (error) {
          this.log.warn(
            `[API] Failed to parse custom options: ${error.message}`,
          );
        }
      }

      this.log.debug(
        `[API] Sending to Tool Server: ${JSON.stringify(payload)}`,
      );

      const response = await this._axios.post(
        `${this._toolServerUrl}/chat/completions`,
        payload,
        {
          headers: { "Content-Type": "application/json" },
          timeout: 50000,
        },
      );

      if (response.data?.choices?.[0]?.message?.content) {
        const content = response.data.choices[0].message.content;
        const contextItems = response.data.rag_context?.length || 0;

        this.log.debug(
          `[API] Tool Server response received with ${contextItems} context items`,
        );
        this.log.debug(
          `[API] Response content: ${content.substring(0, 200)}${content.length > 200 ? "..." : ""}`,
        );

        return content;
      }
      this.log.error(`[API] Invalid Tool Server response format`);
      return null;
    } catch (error) {
      this.log.error(`[API] Tool Server request failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process chat directly via OpenWebUI (OpenWebUI-only fallback)
   *
   * @param {string} modelName - Name of the LLM model to use
   * @param {object} messageObj - Message object with content and role
   * @param {object} options - Optional parameters for the request
   */
  async _processChatViaDirect(modelName, messageObj, options = {}) {
    // This method is kept for potential future use but should not be called
    // in normal operation as we want to avoid bypassing RAG integration
    this.log.warn(
      `[API] Direct OpenWebUI processing called - this bypasses RAG integration`,
    );

    try {
      const messages = [
        {
          role: messageObj.role || "user",
          content: messageObj.content,
        },
      ];

      const payload = {
        model: modelName,
        messages: messages,
        stream: false,
        temperature: this.config?.temperature ?? 0.7,
        max_tokens: this.config?.maxTokens ?? 2048,
      };

      // Add custom options if provided (these override config values)
      if (
        options.options &&
        typeof options.options === "string" &&
        options.options !== "{}"
      ) {
        try {
          const customOptions = JSON.parse(options.options);
          if (customOptions.temperature !== undefined) {
            payload.temperature = customOptions.temperature;
          }
          if (customOptions.max_tokens !== undefined) {
            payload.max_tokens = customOptions.max_tokens;
          }
        } catch {
          this.log.warn(`[API] Invalid options JSON: ${options.options}`);
        }
      }

      this.log.debug(
        `[API] Sending direct to OpenWebUI: ${JSON.stringify(payload)}`,
      );

      const response = await this.sendChatPayload(payload);

      if (response && response.choices && response.choices[0]) {
        const answer = response.choices[0].message?.content || "";
        this.log.warn(
          `[API] Direct response without RAG: ${answer.substring(0, 100)}...`,
        );

        return {
          answer: answer,
          toolCallResults: [],
          modelId: modelName.replace(/[^a-zA-Z0-9_]/g, "_"),
        };
      }
      this.log.error(`[API] Invalid response structure from OpenWebUI`);
      return null;
    } catch (error) {
      this.log.error(`[API] Direct OpenWebUI request failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if Tool Server is available
   */
  async _checkToolServerAvailability() {
    try {
      const response = await this._axios.get(`${this._toolServerUrl}/health`, {
        timeout: 3000,
      });
      return response.status === 200;
    } catch (error) {
      this.log.debug(`[Tools] Tool Server not available: ${error.message}`);
      return false;
    }
  }

  /**
   * Send simple chat payload to OpenWebUI server only
   *
   * @param {object} payload - Chat payload with model, messages, and options
   */
  async sendChatPayload(payload) {
    try {
      // Prepare headers for OpenWebUI
      const headers = {
        "Content-Type": "application/json",
      };

      // Add Authorization header if API key is provided
      if (this._apiKey) {
        headers["Authorization"] = `Bearer ${this._apiKey}`;
      } else {
        this.log.error(
          "[API] No API key configured - OpenWebUI authentication required",
        );
        throw new Error("OpenWebUI API key required for chat requests");
      }

      this.log.debug(
        `[API] Sending to ${this._openWebUIUrl}/api/chat/completions`,
      );

      const resp = await this._axios.post(
        `${this._openWebUIUrl}/api/chat/completions`,
        payload,
        { headers, timeout: 60000 },
      );

      return resp.data;
    } catch (error) {
      if (error.response) {
        this.log.error(
          `Error sending chat payload to OpenWebUI: ${error.message}`,
        );
        this.log.error(`Response status: ${error.response.status}`);
        this.log.error(`Response data: ${JSON.stringify(error.response.data)}`);
      } else {
        this.log.error(`Network error sending to OpenWebUI: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Start model monitoring (simplified)
   *
   * @param {Array} models - Array of model objects to monitor
   * @param {string} namespace - Namespace for state management
   * @param {number} intervalMs - Monitoring interval in milliseconds
   */
  startMonitor(models, namespace, intervalMs) {
    if (this._monitorInterval) {
      clearInterval(this._monitorInterval);
    }

    // Initial check
    this._runMonitor(models);

    if (intervalMs > 0) {
      this._monitorInterval = setInterval(() => {
        this._runMonitor(models);
      }, intervalMs);
    }
  }

  /**
   * Stop model monitoring
   */
  stopMonitor() {
    if (this._monitorInterval) {
      clearInterval(this._monitorInterval);
      this._monitorInterval = null;
    }
  }

  /**
   * Run monitor check
   *
   * @param {Array} models - Array of model objects to check
   */
  async _runMonitor(models) {
    try {
      const runningProcesses = await this.checkRunningModels();
      const runningNames = models
        .filter((m) =>
          runningProcesses.some((p) => p.name === m.name || p.model === m.name),
        )
        .map((m) => m.name);

      this.log.debug(
        `Running models: ${runningNames.length ? runningNames.join(", ") : "none"}`,
      );

      // Update running states
      for (const model of models) {
        const isRunning = runningNames.includes(model.name);
        if (this._setStateCallback) {
          await this._setStateCallback(
            `models.${model.id}.running`,
            isRunning,
            true,
          );
        }
      }
    } catch (error) {
      this.log.error(`Monitor error: ${error.message}`);
    }
  }

  /**
   * Process chat message from ioBroker state change with full state management
   *
   * @param {string} id - State ID that triggered the chat
   * @param {object} state - State object with value and timestamp
   * @param {object} adapter - ioBroker adapter instance
   */
  async processStateBasedChatMessage(id, state, adapter) {
    if (!adapter.ollamaClient) {
      adapter.log.error("OllamaClient is not initialized.");
      return;
    }

    try {
      // Extract model information
      const modelMatch = id.match(/models\.([^.]+)\.messages\.content$/);
      if (!modelMatch) {
        adapter.log.error(`Invalid state ID format: ${id}`);
        return;
      }

      const modelId = modelMatch[1];

      // Check if model is already processing
      const processingState = await adapter.getStateAsync(
        `models.${modelId}.processing`,
      );
      if (processingState?.val === true) {
        adapter.log.warn(
          `[API] Model ${modelId} is already processing a request. Ignoring new request.`,
        );
        return;
      }

      // Set processing state
      await adapter.setState(`models.${modelId}.processing`, true, true);

      try {
        // Get the original model name from the stored state
        const originalNameState = await adapter.getStateAsync(
          `models.${modelId}.originalName`,
        );
        const modelName = originalNameState?.val || modelId.replace(/_/g, ":");

        // Get essential states
        const [roleState, contentState, optionsState] = await Promise.all([
          adapter.getStateAsync(`models.${modelId}.messages.role`),
          adapter.getStateAsync(`models.${modelId}.messages.content`),
          adapter.getStateAsync(`models.${modelId}.options`),
        ]);

        // Build message object
        const messageObj = {
          role: roleState?.val || "user",
          content: contentState?.val || "",
        };

        // Process message
        const result = await this.processChatMessage(modelName, messageObj, {
          options: optionsState?.val,
          stream: false,
        });

        if (result) {
          // Set response state (result is a string directly from processChatMessage)
          await adapter.setState(`models.${modelId}.response`, result, true);

          adapter.log.info(
            `[API] Response set for model ${modelName}: ${result.substring(0, 100)}${result.length > 100 ? "..." : ""}`,
          );
        } else {
          adapter.log.error(`[API] No result received from model ${modelName}`);
        }
      } finally {
        // Always clear processing state
        await adapter.setState(`models.${modelId}.processing`, false, true);
      }
    } catch (error) {
      adapter.log.error(`Error processing chat message: ${error.message}`);
    }
  }

  /**
   * Create ioBroker states for all available models
   *
   * @param {Array} models - Array of model objects to create states for
   * @param {object} adapter - ioBroker adapter instance
   */
  async createModelStates(models, adapter) {
    await adapter.setObjectNotExistsAsync("models", {
      type: "folder",
      common: { name: adapter.translate("Ollama Models") },
      native: {},
    });

    // Create vector database management state
    if (adapter.config.useVectorDb) {
      await adapter.setObjectNotExistsAsync("vectordb", {
        type: "channel",
        common: { name: adapter.translate("Vector Database") },
        native: {},
      });
      await adapter.setObjectNotExistsAsync("vectordb.cleanup", {
        type: "state",
        common: {
          name: adapter.translate("Clean up duplicates"),
          type: "boolean",
          role: "button",
          read: true,
          write: true,
          def: false,
        },
        native: {},
      });
    }

    for (const model of models) {
      const modelId = model.replace(/[^a-zA-Z0-9_]/g, "_");

      adapter.log.debug(
        `[Setup] Creating states for model '${model}' with ID '${modelId}'`,
      );

      // Essential states
      await adapter.setObjectNotExistsAsync(`models.${modelId}`, {
        type: "channel",
        common: { name: model },
        native: {},
      });
      await adapter.setObjectNotExistsAsync(`models.${modelId}.response`, {
        type: "state",
        common: {
          name: adapter.translate("Response"),
          type: "string",
          role: "state",
          read: true,
          write: false,
        },
        native: {},
      });
      await adapter.setObjectNotExistsAsync(`models.${modelId}.running`, {
        type: "state",
        common: {
          name: adapter.translate("Running"),
          type: "boolean",
          role: "indicator.running",
          read: true,
          write: false,
          def: false,
        },
        native: {},
      });
      await adapter.setObjectNotExistsAsync(`models.${modelId}.processing`, {
        type: "state",
        common: {
          name: adapter.translate("Processing"),
          type: "boolean",
          role: "indicator.working",
          read: true,
          write: false,
          def: false,
        },
        native: {},
      });
      await adapter.setObjectNotExistsAsync(`models.${modelId}.content`, {
        type: "state",
        common: {
          name: adapter.translate("Response Content"),
          type: "string",
          role: "state",
          read: true,
          write: false,
        },
        native: {},
      });

      // Message states
      await adapter.setObjectNotExistsAsync(`models.${modelId}.messages`, {
        type: "channel",
        common: { name: adapter.translate("Messages") },
        native: {},
      });
      await adapter.setObjectNotExistsAsync(`models.${modelId}.messages.role`, {
        type: "state",
        common: {
          name: adapter.translate("Role"),
          type: "string",
          role: "state",
          read: true,
          write: true,
          def: "user",
        },
        native: {},
      });
      await adapter.setObjectNotExistsAsync(
        `models.${modelId}.messages.content`,
        {
          type: "state",
          common: {
            name: adapter.translate("Content"),
            type: "string",
            role: "state",
            read: true,
            write: true,
            def: "",
          },
          native: {},
        },
      );
      await adapter.setObjectNotExistsAsync(`models.${modelId}.options`, {
        type: "state",
        common: {
          name: adapter.translate("Options (JSON)"),
          type: "string",
          role: "state",
          read: true,
          write: true,
          def: "{}",
        },
        native: {},
      });

      // Store original model name for later retrieval
      await adapter.setObjectNotExistsAsync(`models.${modelId}.originalName`, {
        type: "state",
        common: {
          name: adapter.translate("Original Model Name"),
          type: "string",
          role: "state",
          read: true,
          write: false,
          def: model,
        },
        native: {},
      });
      await adapter.setState(`models.${modelId}.originalName`, model, true);

      // Add model entry for monitoring
      adapter._models.push({ name: model, id: modelId });
    }
  }

  /**
   * Test OpenWebUI connection and API key validity - required for all operations
   */
  async testOpenWebUIConnection() {
    try {
      this.log.debug("[OpenWebUI] Testing connection and API key...");

      if (!this._apiKey || this._apiKey.trim() === "") {
        this.log.error(
          "[OpenWebUI] No API key configured - OpenWebUI authentication required",
        );
        return false;
      }

      const headers = {
        Authorization: `Bearer ${this._apiKey}`,
        "Content-Type": "application/json",
      };

      const response = await this._axios.get(
        `${this._openWebUIUrl}/api/models`,
        {
          headers,
          timeout: 10000,
        },
      );

      if (response.status === 200) {
        this.log.info("[OpenWebUI] Connection successful and API key valid");

        if (response.data?.data) {
          const modelCount = response.data.data.length;
          this.log.debug(`[OpenWebUI] Found ${modelCount} models available`);
        }

        return true;
      }
      this.log.error(
        `[OpenWebUI] Unexpected response status: ${response.status}`,
      );
      return false;
    } catch (error) {
      if (error.response) {
        const status = error.response.status;
        const statusText = error.response.statusText || "Unknown";

        switch (status) {
          case 401:
            this.log.error(
              "[OpenWebUI] Authentication failed - Invalid API key",
            );
            break;
          case 403:
            this.log.error(
              "[OpenWebUI] Access forbidden - Check API key permissions",
            );
            break;
          case 404:
            this.log.error(
              "[OpenWebUI] API endpoint not found - Check OpenWebUI version",
            );
            break;
          default:
            this.log.error(`[OpenWebUI] HTTP Error ${status}: ${statusText}`);
        }
      } else if (error.code === "ECONNREFUSED") {
        this.log.error(
          `[OpenWebUI] Connection refused to ${this._openWebUIUrl} - Is OpenWebUI running?`,
        );
      } else if (error.code === "ETIMEDOUT") {
        this.log.error(
          `[OpenWebUI] Connection timeout to ${this._openWebUIUrl}`,
        );
      } else {
        this.log.error(`[OpenWebUI] Connection test failed: ${error.message}`);
      }
      return false;
    }
  }

  /**
   * Generate response using Ollama via OpenWebUI API
   *
   * @param {string} prompt - Text prompt
   * @param {object} options - Generation options
   * @returns {Promise<string>} Generated response
   */
  async generateResponse(prompt, options = {}) {
    try {
      const requestData = {
        model: options.model || this.chatModel || "llama3.2",
        messages: [{ role: "user", content: prompt }],
        temperature: options.temperature || 0.7,
        max_tokens: options.max_tokens || 150,
        stream: false,
      };

      this.log.debug(
        `[OllamaClient] Generating response for prompt length: ${prompt.length}`,
      );

      const response = await this._axios.post(
        `${this._openWebUIUrl}/api/chat/completions`,
        requestData,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this._apiKey}`,
          },
          timeout: 30000,
        },
      );

      if (response.data?.choices?.[0]?.message?.content) {
        const result = response.data.choices[0].message.content.trim();
        this.log.debug(
          `[OllamaClient] Generated response length: ${result.length}`,
        );
        return result;
      }
      throw new Error("Invalid response format from OpenWebUI");
    } catch (error) {
      this.log.error(
        `[OllamaClient] Generate response error: ${error.message}`,
      );
      throw error;
    }
  }
}

module.exports = OllamaClient;
