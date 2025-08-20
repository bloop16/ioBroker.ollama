"use strict";

const HttpClient = require("./httpClient");

/**
 * OllamaClient handles interactions with OpenWebUI (primary) and Ollama (fallback) APIs
 * New Architecture: OpenWebUI first, Ollama as fallback when OpenWebUI unavailable
 * Provides chat completion, model management, and ToolServer integration
 */
class OllamaClient {
  /**
   * @param {string} openWebUIUrl - OpenWebUI server URL for chat API (primary)
   * @param {object} logger - Logger instance for debug and error messages
   * @param {object} [config] - Adapter configuration
   * @param {Function} [translateFn] - ioBroker translation function
   */
  constructor(openWebUIUrl, logger, config, translateFn) {
    this._openWebUIUrl = openWebUIUrl;
    this._ollamaUrl =
      config?.ollamaUrl ||
      `http://${config?.ollamaIp || "127.0.0.1"}:${config?.ollamaPort || 11434}`;
    this._toolServerUrl = config?.toolServerUrl || `http://127.0.0.1:9100`;

    // Use centralized HTTP client for connection pooling and optimization
    this._httpClient = HttpClient;
    this._openWebUIClient = this._httpClient.getOpenWebUI(config?.apiKey);
    this._ollamaClient = this._httpClient.getOllama();
    this._defaultClient = this._httpClient.getDefault();
    // Configuration and state
    this.log = logger;
    this.translate = translateFn || ((key) => key);
    this._apiKey = config?.apiKey || "";
    this._monitorInterval = null;
    this._setStateCallback = config?.setStateCallback;
    this.config = config || {};
    this.chatModel = config?.toolServerChatModel || "llama3.2";

    // Request timeouts and limits
    this._requestTimeout = config?.llmRequestTimeout * 1000 || 1200000; // 20 minutes default
    this._maxRetries = 3;
    this._retryDelay = 1000; // 1 second base delay

    // Architecture flags
    this._openWebUIAvailable = false;
    this._toolServerAvailable = false;
    this._lastOpenWebUICheck = 0;
    this._checkInterval = 30000; // 30 seconds

    // DatapointController integration (now handled by ToolServer)
    this._datapointController = null;
    this._datapointControlEnabled = false;

    const logMessage = this.translate("general_initialized").replace(
      "{{component}}",
      "OllamaClient (OpenWebUI-first Architecture)",
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
   * Validate and sanitize input parameters for security
   *
   * @param {string} input - Input string to validate
   * @param {string} type - Type of input (content, model, url)
   * @param {number} maxLength - Maximum allowed length
   * @returns {string} Sanitized input
   * @throws {Error} If input is invalid
   */
  _validateInput(input, type = "content", maxLength = 100000) {
    if (typeof input !== "string") {
      throw new Error(`Invalid ${type}: must be a string`);
    }

    if (input.length === 0) {
      throw new Error(`Empty ${type} not allowed`);
    }

    if (input.length > maxLength) {
      throw new Error(`${type} too long: maximum ${maxLength} characters`);
    }

    // Remove potentially dangerous characters and patterns
    const sanitized = input
      .replace(/[^\u0020-\u007E\u00A0-\uFFFF]/g, "") // Remove control characters (keep printable ASCII and Unicode)
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "") // Remove script tags
      .trim();

    if (sanitized.length === 0) {
      throw new Error(`${type} became empty after sanitization`);
    }

    return sanitized;
  }

  /**
   * Retry mechanism with exponential backoff
   *
   * @param {Function} operation - Async operation to retry
   * @param {string} operationName - Name for logging
   * @param {number} maxRetries - Maximum retry attempts
   * @returns {Promise<any>} Operation result
   */
  async _retryOperation(
    operation,
    operationName,
    maxRetries = this._maxRetries,
  ) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation();
        if (attempt > 1) {
          this.log.debug(
            `[OllamaClient] ${operationName} succeeded on attempt ${attempt}`,
          );
        }
        return result;
      } catch (error) {
        lastError = error;

        // Don't retry on certain error types
        if (this._isNonRetryableError(error)) {
          this.log.debug(
            `[OllamaClient] Non-retryable error for ${operationName}: ${error.message}`,
          );
          throw error;
        }

        if (attempt < maxRetries) {
          const delay = this._retryDelay * Math.pow(2, attempt - 1); // Exponential backoff
          this.log.warn(
            `[OllamaClient] ${operationName} failed (attempt ${attempt}/${maxRetries}): ${error.message}. Retrying in ${delay}ms...`,
          );
          await this._sleep(delay);
        }
      }
    }

    this.log.error(
      `[OllamaClient] ${operationName} failed after ${maxRetries} attempts`,
    );
    throw lastError;
  }

  /**
   * Check if error should not be retried
   *
   * @param {any} error - Error to check
   * @returns {boolean} True if error should not be retried
   */
  _isNonRetryableError(error) {
    const nonRetryableStatus = [400, 401, 403, 404, 422]; // Client errors
    const nonRetryableMessages = [
      "invalid api key",
      "unauthorized",
      "forbidden",
    ];

    // Check for axios error with response status
    if (
      error &&
      error.response &&
      error.response.status &&
      nonRetryableStatus.includes(error.response.status)
    ) {
      return true;
    }

    const errorMessage =
      error && error.message ? error.message.toLowerCase() : "";
    return nonRetryableMessages.some((msg) => errorMessage.includes(msg));
  }

  /**
   * Sleep utility for retry delays
   *
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Start progress monitoring for long-running requests
   * Outputs info messages every 30 seconds to show request is still active
   *
   * @param {string} requestType - Type of request (e.g., "Chat completion", "Embedding generation")
   * @param {string} model - Model name being used
   * @returns {number} Interval ID for cleanup
   */
  _startProgressMonitor(requestType, model) {
    const startTime = Date.now();
    let checkCount = 0;

    const intervalId = setInterval(() => {
      checkCount++;
      const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
      const minutes = Math.floor(elapsedSeconds / 60);
      const seconds = elapsedSeconds % 60;

      const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

      this.log.debug(
        `[${requestType}] Processing request with model "${model}" (${timeStr}, check #${checkCount})`,
      );
    }, 30000); // Every 30 seconds

    this.log.debug(
      `[${requestType}] Started processing request with model "${model}"`,
    );

    return Number(intervalId);
  }

  /**
   * Stop progress monitoring
   *
   * @param {number|null} intervalId - Interval ID from _startProgressMonitor
   * @param {string} requestType - Type of request
   * @param {string} model - Model name
   * @param {boolean} success - Whether request completed successfully
   */
  _stopProgressMonitor(intervalId, requestType, model, success = true) {
    if (intervalId) {
      clearInterval(intervalId);

      const status = success ? "completed successfully" : "failed";
      this.log.info(
        `[${requestType}] Request processing with model "${model}" ${status}`,
      );
    }
  }

  /**
   * Build HTTP headers for API requests with clean API key
   *
   * @param {object} [baseHeaders] - Base headers to extend
   * @returns {object} HTTP headers object
   */
  _buildHeaders(baseHeaders = {}) {
    const headers = { ...baseHeaders };

    // Only add authorization header if apiKey is valid
    if (
      this._apiKey &&
      typeof this._apiKey === "string" &&
      this._apiKey.trim().length > 0
    ) {
      // Clean the API key to remove any invalid characters
      const cleanApiKey = this._apiKey
        .trim()
        .replace(/[\r\n\t]/g, "")
        .replace(/[^\x20-\x7E]/g, ""); // Keep only printable ASCII characters

      if (cleanApiKey.length > 0) {
        headers["Authorization"] = `Bearer ${cleanApiKey}`;
      }
    }

    return headers;
  }

  /**
   * Update the ToolServer URL after ToolServer has started
   *
   * @param {string} toolServerUrl - New ToolServer URL
   */
  setToolServerUrl(toolServerUrl) {
    this._toolServerUrl = toolServerUrl;
    this.log.debug(`[OllamaClient] ToolServer URL updated: ${toolServerUrl}`);
  }

  /**
   * Check OpenWebUI and ToolServer availability
   */
  async _checkServicesAvailability() {
    const now = Date.now();
    if (now - this._lastOpenWebUICheck < this._checkInterval) {
      return;
    }

    this._lastOpenWebUICheck = now;

    // Check OpenWebUI
    try {
      await this._defaultClient.get(`${this._openWebUIUrl}/api/models`, {
        headers: this._apiKey
          ? { Authorization: `Bearer ${this._apiKey}` }
          : {},
        timeout: 5000,
      });
      this._openWebUIAvailable = true;
    } catch {
      this._openWebUIAvailable = false;
    }

    // Check ToolServer
    try {
      await this._defaultClient.get(`${this._toolServerUrl}/health`, {
        timeout: 5000,
      });
      this._toolServerAvailable = true;
    } catch {
      this._toolServerAvailable = false;
    }

    this.log.debug(
      `[OllamaClient] Service availability - OpenWebUI: ${this._openWebUIAvailable}, ToolServer: ${this._toolServerAvailable}`,
    );
  }

  /**
   * Configure datapoint control functionality
   *
   * @param {boolean} enabled - Enable/disable datapoint control
   * @param {Set} allowedDatapoints - Set of allowed datapoint IDs
   */
  configureDatapointControl(enabled, allowedDatapoints) {
    this._datapointControlEnabled = enabled;
    if (this._datapointController) {
      this._datapointController.setAllowedDatapoints(
        allowedDatapoints || new Set(),
      );
    }
    this.log.debug(
      `[OllamaClient] Datapoint control ${enabled ? "enabled" : "disabled"} with ${(allowedDatapoints || new Set()).size} allowed datapoints`,
    );
  }

  /**
   * Set the datapoint controller instance
   *
   * @param {object} controller - DatapointController instance
   */
  setDatapointController(controller) {
    this._datapointController = controller;
    this.log.debug("[OllamaClient] DatapointController configured");
  }

  /**
   * Fetch available models directly from Ollama API
   */
  async fetchModels() {
    try {
      this.log.debug(
        `[API] Fetching models from Ollama: ${this._ollamaUrl}/api/tags`,
      );
      const resp = await this._ollamaClient.get(`${this._ollamaUrl}/api/tags`, {
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
      const resp = await this._ollamaClient.get(`${this._ollamaUrl}/api/ps`, {
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
   * Process chat message with new OpenWebUI-first architecture
   * 1. Try OpenWebUI with ToolServer (primary)
   * 2. Try OpenWebUI directly (secondary)
   * 3. Try Ollama directly (fallback)
   *
   * @param {string} modelName - Name of the LLM model to use
   * @param {object} messageObj - Message object with content and role
   * @param {object} options - Optional parameters for the request
   */
  async processChatMessage(modelName, messageObj, options = {}) {
    // Input validation and sanitization
    try {
      modelName = this._validateInput(modelName, "model name", 100);
      if (messageObj?.content) {
        messageObj.content = this._validateInput(
          messageObj.content,
          "message content",
        );
      }
    } catch (error) {
      this.log.error(
        `[OllamaClient] Input validation failed: ${error.message}`,
      );
      throw error;
    }

    await this._checkServicesAvailability();

    this.log.debug(
      `[OllamaClient] Processing chat message with OpenWebUI-first architecture`,
    );

    // 1. Primary: OpenWebUI + ToolServer (if both available)
    if (this._openWebUIAvailable && this._toolServerAvailable) {
      try {
        this.log.debug(
          `[OllamaClient] Trying OpenWebUI + ToolServer (primary)`,
        );
        return await this._processChatViaToolServer(
          modelName,
          messageObj,
          options,
        );
      } catch (error) {
        this.log.warn(
          `[OllamaClient] OpenWebUI + ToolServer failed: ${error.message}`,
        );
        // Continue to next option
      }
    }

    // 2. Secondary: OpenWebUI directly (no ToolServer)
    if (this._openWebUIAvailable) {
      try {
        this.log.debug(`[OllamaClient] Trying OpenWebUI directly (secondary)`);
        return await this._processChatViaOpenWebUI(
          modelName,
          messageObj,
          options,
        );
      } catch (error) {
        this.log.warn(
          `[OllamaClient] OpenWebUI direct failed: ${error.message}`,
        );
        // Continue to fallback
      }
    }

    // 3. Fallback: Ollama directly
    this.log.warn(
      `[OllamaClient] Using Ollama fallback (OpenWebUI unavailable)`,
    );
    return await this._processChatViaOllama(modelName, messageObj, options);
  }

  /**
   * Process chat via Tool Server with RAG integration
   *
   * @param {string} modelName - Name of the LLM model to use
   * @param {object} messageObj - Message object with content and role
   * @param {object} options - Optional parameters for the request
   */
  async _processChatViaToolServer(modelName, messageObj, options = {}) {
    return await this._retryOperation(async () => {
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

      const response = await this._defaultClient.post(
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
      throw new Error("Invalid Tool Server response format");
    }, "ToolServer Chat");
  }

  /**
   * Process chat via OpenWebUI directly (without ToolServer)
   *
   * @param {string} modelName - Name of the LLM model to use
   * @param {object} messageObj - Message object with content and role
   * @param {object} options - Optional parameters for the request
   */
  async _processChatViaOpenWebUI(modelName, messageObj, options = {}) {
    let progressMonitor = null;
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
        temperature: options.temperature || 0.7,
        max_tokens: options.max_tokens || 500,
        stream: false,
      };

      this.log.debug(
        `[OllamaClient] Sending to OpenWebUI: ${JSON.stringify(payload)}`,
      );

      // Start progress monitoring
      progressMonitor = this._startProgressMonitor("OpenWebUI Chat", modelName);

      const response = await this._openWebUIClient.post(
        `${this._openWebUIUrl}/api/chat/completions`,
        payload,
        {
          timeout: this._requestTimeout,
        },
      );

      if (response.data?.choices?.[0]?.message?.content) {
        const content = response.data.choices[0].message.content;
        this.log.debug(
          `[OllamaClient] OpenWebUI response: ${content.substring(0, 200)}${content.length > 200 ? "..." : ""}`,
        );

        // Stop progress monitoring on success
        this._stopProgressMonitor(
          progressMonitor,
          "OpenWebUI Chat",
          modelName,
          true,
        );

        return content;
      }

      // Stop progress monitoring on error
      this._stopProgressMonitor(
        progressMonitor,
        "OpenWebUI Chat",
        modelName,
        false,
      );
      throw new Error("Invalid OpenWebUI response format");
    } catch (error) {
      // Stop progress monitoring on exception
      this._stopProgressMonitor(
        progressMonitor,
        "OpenWebUI Chat",
        modelName,
        false,
      );

      this.log.error(
        `[OllamaClient] OpenWebUI request failed: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Process chat via Ollama directly (fallback)
   *
   * @param {string} modelName - Name of the LLM model to use
   * @param {object} messageObj - Message object with content and role
   * @param {object} options - Optional parameters for the request
   */
  async _processChatViaOllama(modelName, messageObj, options = {}) {
    let progressMonitor = null;
    try {
      const payload = {
        model: modelName,
        prompt: messageObj.content,
        stream: false,
        options: {
          temperature: options.temperature || 0.7,
          num_predict: options.max_tokens || 500,
        },
      };

      this.log.debug(
        `[OllamaClient] Sending to Ollama fallback: ${JSON.stringify(payload)}`,
      );

      // Start progress monitoring for fallback
      progressMonitor = this._startProgressMonitor(
        "Ollama Fallback",
        modelName,
      );

      const response = await this._ollamaClient.post(
        `${this._ollamaUrl}/api/generate`,
        payload,
        {
          timeout: this._requestTimeout,
        },
      );

      if (response.data?.response) {
        const content = response.data.response;
        this.log.debug(
          `[OllamaClient] Ollama fallback response: ${content.substring(0, 200)}${content.length > 200 ? "..." : ""}`,
        );

        // Stop progress monitoring on success
        this._stopProgressMonitor(
          progressMonitor,
          "Ollama Fallback",
          modelName,
          true,
        );

        return content;
      }

      // Stop progress monitoring on error
      this._stopProgressMonitor(
        progressMonitor,
        "Ollama Fallback",
        modelName,
        false,
      );
      throw new Error("Invalid Ollama response format");
    } catch (error) {
      // Stop progress monitoring on exception
      this._stopProgressMonitor(
        progressMonitor,
        "Ollama Fallback",
        modelName,
        false,
      );

      this.log.error(`[OllamaClient] Ollama fallback failed: ${error.message}`);
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
      const response = await this._defaultClient.get(
        `${this._toolServerUrl}/health`,
        {
          timeout: 3000,
        },
      );
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

      const resp = await this._openWebUIClient.post(
        `${this._openWebUIUrl}/api/chat/completions`,
        payload,
        { timeout: 60000 },
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
   * @param {object} adapter - ioBroker adapter instance for timer management
   */
  startMonitor(models, namespace, intervalMs, adapter) {
    if (this._monitorInterval) {
      adapter.clearInterval(this._monitorInterval);
    }

    // Initial check
    this._runMonitor(models);

    if (intervalMs > 0) {
      this._monitorInterval = adapter.setInterval(() => {
        this._runMonitor(models);
      }, intervalMs);
    }
  }

  /**
   * Stop model monitoring
   *
   * @param {object} adapter - ioBroker adapter instance for timer management
   */
  stopMonitor(adapter) {
    if (this._monitorInterval) {
      adapter.clearInterval(this._monitorInterval);
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
   * Handle function calls from AI model
   *
   * @param {Array} toolCalls - Array of tool calls from the model
   * @param {string} originalPrompt - Original user prompt
   * @param {object} originalRequest - Original request data
   * @returns {Promise<string>} Final response after function execution
   */
  async _handleFunctionCalls(toolCalls, originalPrompt, originalRequest) {
    const functionResults = [];

    this.log.debug(
      `[OllamaClient] Processing ${toolCalls.length} function calls`,
    );

    // Execute each function call
    for (const toolCall of toolCalls) {
      try {
        if (toolCall.type === "function") {
          const functionName = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments);

          this.log.debug(
            `[OllamaClient] Executing function: ${functionName}`,
            args,
          );

          const result = await this._datapointController.executeFunctionCall(
            functionName,
            args,
          );

          functionResults.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: functionName,
            content: JSON.stringify(result),
          });

          this.log.debug(
            `[OllamaClient] Function ${functionName} executed successfully`,
          );
        }
      } catch (error) {
        this.log.error(`[OllamaClient] Function call error: ${error.message}`);
        functionResults.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: toolCall.function?.name || "unknown",
          content: JSON.stringify({
            success: false,
            error: error.message,
          }),
        });
      }
    }

    // Send function results back to model for final response
    try {
      const followUpRequest = {
        ...originalRequest,
        messages: [
          ...originalRequest.messages,
          {
            role: "assistant",
            tool_calls: toolCalls,
          },
          ...functionResults,
        ],
      };

      const followUpResponse = await this._openWebUIClient.post(
        `${this._openWebUIUrl}/api/chat/completions`,
        followUpRequest,
        {
          timeout: this._requestTimeout,
        },
      );

      if (followUpResponse.data?.choices?.[0]?.message?.content) {
        const finalResult =
          followUpResponse.data.choices[0].message.content.trim();
        this.log.debug(
          `[OllamaClient] Function calling completed, final response length: ${finalResult.length}`,
        );
        return finalResult;
      }

      // Fallback: return function results as formatted text
      return this._formatFunctionResults(functionResults);
    } catch (error) {
      this.log.error(
        `[OllamaClient] Follow-up request failed: ${error.message}`,
      );
      return this._formatFunctionResults(functionResults);
    }
  }

  /**
   * Format function results as human-readable text
   *
   * @param {Array} functionResults - Array of function execution results
   * @returns {string} Formatted results
   */
  _formatFunctionResults(functionResults) {
    const results = functionResults.map((result) => {
      try {
        const content = JSON.parse(result.content);
        if (content.success) {
          return `✓ ${result.name}: ${content.message}`;
        }
        return `✗ ${result.name}: ${content.error || content.message}`;
      } catch {
        return `${result.name}: ${result.content}`;
      }
    });

    return `Function execution results:\n${results.join("\n")}`;
  }
}

module.exports = OllamaClient;
