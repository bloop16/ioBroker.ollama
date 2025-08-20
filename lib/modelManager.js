"use strict";

/**
 * ModelManager - Intelligent model status monitoring and request queuing
 * Uses Ollama's native /api/ps endpoint to track actual model status
 * Implements proper queue system to prevent conflicts and optimize resource usage
 */
class ModelManager {
  /**
   * @param {object} ollamaUrl - Ollama server URL
   * @param {object} logger - Logger instance
   * @param {object} httpClient - HTTP client for API calls
   */
  constructor(ollamaUrl, logger, httpClient) {
    this.ollamaUrl = ollamaUrl;
    this.log = logger;
    this.httpClient = httpClient;

    // Request queue management
    this.requestQueues = new Map(); // model -> array of pending requests
    this.activeRequests = new Map(); // model -> current request info
    this.modelStatus = new Map(); // model -> status object

    // Configuration
    this.statusCheckInterval = 10000; // Check every 10 seconds
    this.requestTimeout = 300000; // 5 minutes timeout per request
    this.maxRetries = 3;

    // Request handler (to be injected)
    this._requestHandler = null;

    // Start status monitoring
    this._startStatusMonitoring();

    this.log.info("[ModelManager] Initialized with intelligent queue system");
  }

  /**
   * Start monitoring model status using Ollama's /api/ps endpoint
   */
  _startStatusMonitoring() {
    this._statusInterval = setInterval(async () => {
      await this._updateModelStatus();
    }, this.statusCheckInterval);

    // Initial status check
    this._updateModelStatus();
  }

  /**
   * Update model status using Ollama's native API
   */
  async _updateModelStatus() {
    try {
      const ollamaClient = this.httpClient.getOllama();
      const response = await ollamaClient.get(`${this.ollamaUrl}/api/ps`, {
        timeout: 5000,
      });

      const runningModels = response.data.models || [];
      const currentTime = Date.now();

      // Clear previous status
      for (const [modelName] of this.modelStatus) {
        this.modelStatus.set(modelName, {
          ...this.modelStatus.get(modelName),
          isLoaded: false,
          isIdle: true,
        });
      }

      // Update status for running models
      for (const model of runningModels) {
        const modelName = model.name || model.model;
        const expiresAt = model.expires_at
          ? new Date(model.expires_at).getTime()
          : null;
        const sizeVram = model.size_vram || model.size || 0;

        // Determine if model is actively processing
        const isProcessing = this.activeRequests.has(modelName);

        // Model is idle if loaded but not processing and close to expiration
        const isIdle =
          !isProcessing && expiresAt && expiresAt - currentTime < 30000; // 30 seconds

        this.modelStatus.set(modelName, {
          isLoaded: true,
          isProcessing,
          isIdle,
          expiresAt,
          sizeVram,
          lastSeen: currentTime,
        });
      }

      // Process queues for available models
      this._processModelQueues();
    } catch (error) {
      this.log.debug(`[ModelManager] Status check failed: ${error.message}`);
    }
  }

  /**
   * Process pending requests for available models
   */
  _processModelQueues() {
    for (const [modelName, queue] of this.requestQueues) {
      if (queue.length === 0) {
        continue;
      }

      // Model is available if it's not currently processing
      const isAvailable = !this.activeRequests.has(modelName);

      if (isAvailable) {
        const nextRequest = queue.shift();
        if (nextRequest) {
          this._executeRequest(modelName, nextRequest);
        }
      }
    }
  }

  /**
   * Queue a chat request for a model
   *
   * @param {string} modelName - Name of the model
   * @param {object} requestData - Request parameters
   * @returns {Promise<string>} Response from the model
   */
  async queueRequest(modelName, requestData) {
    return new Promise((resolve, reject) => {
      const request = {
        modelName,
        requestData,
        resolve,
        reject,
        timestamp: Date.now(),
        retries: 0,
      };

      // Check if model is immediately available
      if (!this.activeRequests.has(modelName)) {
        this._executeRequest(modelName, request);
      } else {
        // Add to queue
        if (!this.requestQueues.has(modelName)) {
          this.requestQueues.set(modelName, []);
        }
        this.requestQueues.get(modelName).push(request);

        const queueLength = this.requestQueues.get(modelName).length;
        this.log.info(
          `[ModelManager] Request queued for model ${modelName} (position ${queueLength})`,
        );
      }
    });
  }

  /**
   * Execute a request for a model
   *
   * @param {string} modelName - Name of the model
   * @param {object} request - Request object
   */
  async _executeRequest(modelName, request) {
    this.activeRequests.set(modelName, {
      request,
      startTime: Date.now(),
    });

    this.log.info(`[ModelManager] Starting request for model ${modelName}`);

    try {
      // Update model status as processing
      const currentStatus = this.modelStatus.get(modelName) || {};
      this.modelStatus.set(modelName, {
        ...currentStatus,
        isProcessing: true,
        isIdle: false,
      });

      // Execute the actual request
      const result = await this._performModelRequest(
        modelName,
        request.requestData,
      );

      request.resolve(result);
      this.log.info(`[ModelManager] Request completed for model ${modelName}`);
    } catch (error) {
      // Handle retries
      if (request.retries < this.maxRetries && this._shouldRetry(error)) {
        request.retries++;
        this.log.warn(
          `[ModelManager] Retrying request for model ${modelName} (attempt ${request.retries}/${this.maxRetries})`,
        );

        // Re-queue with delay
        setTimeout(() => {
          if (!this.requestQueues.has(modelName)) {
            this.requestQueues.set(modelName, []);
          }
          this.requestQueues.get(modelName).unshift(request); // Add to front of queue
        }, 1000 * request.retries); // Exponential backoff
      } else {
        request.reject(error);
        this.log.error(
          `[ModelManager] Request failed for model ${modelName}: ${error.message}`,
        );
      }
    } finally {
      // Clear active request
      this.activeRequests.delete(modelName);

      // Update model status
      const currentStatus = this.modelStatus.get(modelName) || {};
      this.modelStatus.set(modelName, {
        ...currentStatus,
        isProcessing: false,
      });

      // Process next request in queue immediately
      setTimeout(() => this._processModelQueues(), 100);
    }
  }

  /**
   * Perform the actual model request
   *
   * @param {string} modelName - Name of the model
   * @param {object} requestData - Request parameters
   * @returns {Promise<string>} Model response
   */
  async _performModelRequest(modelName, requestData) {
    // This method is designed to be overridden by setRequestHandler()
    // If no handler is set, we use a default implementation
    if (this._requestHandler && typeof this._requestHandler === "function") {
      return await this._requestHandler(modelName, requestData);
    }

    // Default fallback implementation
    throw new Error(
      "No request handler configured. Use setRequestHandler() to inject the actual request implementation.",
    );
  }

  /**
   * Check if error should trigger a retry
   *
   * @param {any} error - Error object
   * @returns {boolean} True if should retry
   */
  _shouldRetry(error) {
    const retryableStatus = [429, 500, 502, 503, 504]; // Rate limit, server errors
    const retryableMessages = [
      "timeout",
      "network error",
      "connection reset",
      "model loading",
    ];

    // Check HTTP status
    if (
      error?.response?.status &&
      retryableStatus.includes(error.response.status)
    ) {
      return true;
    }

    // Check error message
    const errorMessage = (error?.message || "").toLowerCase();
    return retryableMessages.some((msg) => errorMessage.includes(msg));
  }

  /**
   * Stop an idle model to free resources
   *
   * @param {string} modelName - Name of the model to stop
   */
  async stopIdleModel(modelName) {
    try {
      const _status = this.modelStatus.get(modelName);
      if (!_status || !_status.isIdle || _status.isProcessing) {
        this.log.debug(
          `[ModelManager] Model ${modelName} is not idle, cannot stop`,
        );
        return false;
      }

      this.log.info(`[ModelManager] Stopping idle model ${modelName}`);

      const ollamaClient = this.httpClient.getOllama();
      await ollamaClient.post(
        `${this.ollamaUrl}/api/generate`,
        {
          model: modelName,
          keep_alive: 0,
        },
        {
          timeout: 10000,
        },
      );

      // Update status
      this.modelStatus.delete(modelName);

      return true;
    } catch (error) {
      this.log.warn(
        `[ModelManager] Failed to stop model ${modelName}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Get current status of all models
   */
  getModelStatus() {
    const loaded = [];
    const processing = [];
    const idle = [];
    const queued = {};

    for (const [modelName, modelStatus] of this.modelStatus) {
      if (modelStatus.isLoaded) {
        loaded.push(modelName);

        if (modelStatus.isProcessing) {
          processing.push(modelName);
        } else if (modelStatus.isIdle) {
          idle.push(modelName);
        }
      }
    }

    for (const [modelName, queue] of this.requestQueues) {
      if (queue.length > 0) {
        queued[modelName] = queue.length;
      }
    }

    return {
      loaded,
      processing,
      idle,
      queued,
    };
  }

  /**
   * Check if a specific model is available for requests
   *
   * @param {string} modelName - Name of the model
   * @returns {boolean} True if available
   */
  isModelAvailable(modelName) {
    return !this.activeRequests.has(modelName);
  }

  /**
   * Get queue length for a model
   *
   * @param {string} modelName - Name of the model
   * @returns {number} Number of queued requests
   */
  getQueueLength(modelName) {
    const queue = this.requestQueues.get(modelName);
    return queue ? queue.length : 0;
  }

  /**
   * Clear all queues (useful for shutdown)
   */
  clearAllQueues() {
    for (const [_modelName, queue] of this.requestQueues) {
      for (const request of queue) {
        request.reject(new Error("System shutdown"));
      }
    }
    this.requestQueues.clear();
    this.activeRequests.clear();
  }

  /**
   * Shutdown the model manager
   */
  shutdown() {
    if (this._statusInterval) {
      clearInterval(this._statusInterval);
      this._statusInterval = null;
    }

    this.clearAllQueues();
    this.log.info("[ModelManager] Shutdown completed");
  }

  /**
   * Set the request handler function
   *
   * @param {function(string, any): Promise<string>} handler - Function to handle model requests
   */
  setRequestHandler(handler) {
    this._requestHandler = handler;
  }
}

module.exports = ModelManager;
