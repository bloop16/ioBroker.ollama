"use strict";

const { QdrantClient } = require("@qdrant/qdrant-js");
const axios = require("axios");
const OllamaClient = require("./ollamaClient");

/**
 * Helper class for Qdrant vector database operations
 * Provides utilities for embedding storage, retrieval, and management
 */
class QdrantHelper {
  /**
   * Checks the availability of Qdrant server
   *
   * @param {string} ip - IP address of the Qdrant server
   * @param {number|string} port - Port number of the Qdrant server
   * @param {object} log - Logger instance with info, error, debug methods
   * @returns {Promise<boolean>} Promise that resolves to server availability status
   * @throws Will throw an error if the server is not reachable
   */
  static async checkAvailability(ip, port, log) {
    const url = OllamaClient.createHttpUrl(ip, port);
    const client = new QdrantClient({ url });
    try {
      await client.getCollections();
      if (log.debug) {
        log.debug(`[VectorDB] Qdrant server available at ${url}`);
      }
      return true;
    } catch (err) {
      log.error(`[VectorDB] Error connecting to Qdrant: ${err.message}`);
      throw err;
    }
  }

  /**
   * Process a datapoint for embedding storage in vector database
   *
   * @param {string} id - Datapoint ID
   * @param {object} state - State object with value and timestamp
   * @param {object} config - adapter configuration
   * @param {object} log - ioBroker logger
   * @param {Set|object} processedStates - Set of already processed state IDs or LRU cache
   * @param {Function} getForeignObjectAsync - Function to get ioBroker objects
   * @returns {Promise<boolean>} Success status
   */
  static async processEmbeddingDatapoint(
    id,
    state,
    config,
    log,
    processedStates,
    getForeignObjectAsync,
  ) {
    if (!config.useVectorDb) {
      return false;
    }

    try {
      const obj = await getForeignObjectAsync(id);
      if (!obj?.common?.custom) {
        return false;
      }

      // Find adapter's namespace in custom config
      let customConfig = null;
      for (const namespace in obj.common.custom) {
        if (namespace.startsWith("ollama.")) {
          customConfig = obj.common.custom[namespace];
          break;
        }
      }

      if (!customConfig?.enabled) {
        return false;
      }

      // Enhanced deduplication: check if this exact value was recently processed
      // Use a combination of ID and value, but add a reasonable time window
      const stateKey = `${id}_${state.val}`;
      const now = Date.now();

      // Check if we have this exact state in cache
      if (processedStates.has && processedStates.has(stateKey)) {
        // For LRU cache, get the timestamp when this was last processed
        const lastProcessed = processedStates.get
          ? processedStates.get(stateKey)
          : now;

        // Only skip if processed within the last 5 minutes (300000ms)
        // This prevents spam while allowing legitimate state changes
        if (typeof lastProcessed === "number" && now - lastProcessed < 300000) {
          log.debug(
            `[VectorDB] Skipping duplicate state for ${id}: ${state.val} (processed ${Math.round((now - lastProcessed) / 1000)}s ago)`,
          );
          return false;
        }
      }

      // Additional check: Rate limiting per datapoint ID (regardless of value)
      // This prevents too frequent updates from the same datapoint
      const datapointKey = `${id}_ratelimit`;
      if (processedStates.has && processedStates.has(datapointKey)) {
        const lastUpdate = processedStates.get ? processedStates.get(datapointKey) : now;
        
        // Enforce minimum 30-second interval between any updates for the same datapoint
        if (typeof lastUpdate === "number" && now - lastUpdate < 30000) {
          log.debug(
            `[VectorDB] Rate limiting ${id}: waiting ${Math.round(30 - (now - lastUpdate) / 1000)}s before next update`,
          );
          return false;
        }
      }

      // Store the current timestamp for this state and rate limiting
      if (processedStates.set) {
        processedStates.set(stateKey, now);
        processedStates.set(datapointKey, now);
      } else if (processedStates.add) {
        processedStates.add(stateKey);
        processedStates.add(datapointKey);
      }

      // Note: LRU cache automatically handles cleanup, no manual intervention needed

      const openWebUIUrl = OllamaClient.createHttpUrl(
        config.openWebUIIp,
        config.openWebUIPort,
      );
      const qdrantUrl = OllamaClient.createHttpUrl(
        config.vectorDbIp,
        config.vectorDbPort,
      );

      await this.processEmbeddingEnabledDatapoint(
        id,
        state,
        customConfig,
        openWebUIUrl,
        qdrantUrl,
        log,
        config.embeddingModel || "nomic-embed-text",
        config.openWebUIApiKey || "",
      );

      // Note: Random cleanup removed - now using configurable retention policy
      return true;
    } catch (error) {
      log.error(
        `[VectorDB] Error processing embedding for ${id}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Process an embedding-enabled datapoint for vector storage
   *
   * @param {string} id - Datapoint ID
   * @param {object} state - State object
   * @param {object} customConfig - Custom configuration
   * @param {string} openWebUIUrl - OpenWebUI server URL
   * @param {string} qdrantUrl - Qdrant server URL
   * @param {object} log - Logger instance
   * @param {string} embeddingModel - Model for embeddings
   * @param {string} apiKey - API key for authentication
   * @returns {Promise<boolean>} Success status
   */
  static async processEmbeddingEnabledDatapoint(
    id,
    state,
    customConfig,
    openWebUIUrl,
    qdrantUrl,
    log,
    embeddingModel = "nomic-embed-text",
    apiKey = "",
  ) {
    try {
      const formattedData = this.formatDataForVectorDB(id, state, customConfig);
      const embedding = await this.generateEmbedding(
        formattedData.formattedText,
        openWebUIUrl,
        log,
        embeddingModel,
        apiKey,
      );
      const dataWithEmbedding = { ...formattedData, embedding };
      await this.sendToQdrant(
        dataWithEmbedding,
        qdrantUrl,
        "iobroker_datapoints",
        log,
      );
      return true;
    } catch (error) {
      log.error(
        `[VectorDB] Error processing datapoint ${id}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Format datapoint data for vector database storage
   *
   * @param {string} id - Datapoint ID
   * @param {object} state - State object with value and timestamp
   * @param {object} customConfig - Custom configuration for formatting
   * @returns {object} Formatted data object
   */
  static formatDataForVectorDB(id, state, customConfig) {
    const timestamp = new Date().toISOString();

    // Extract readable parts from the datapoint ID
    const datapointParts = id.split(".");
    const deviceName = datapointParts[datapointParts.length - 1]; // e.g., "ACTUAL_TEMPERATURE"
    const deviceChannel =
      datapointParts.length > 2
        ? datapointParts[datapointParts.length - 2]
        : "";

    const baseData = {
      id,
      timestamp,
      value: state.val,
      description: customConfig.description || "",
      location: customConfig.location || "",
      dataType: customConfig.dataType || "text",
      allowAutoChange: customConfig.allowAutoChange || false,
      booleanTrueValue: customConfig.booleanTrueValue,
      booleanFalseValue: customConfig.booleanFalseValue,
      deviceName: deviceName, // Store original device name for search
      deviceChannel: deviceChannel,
    };

    let formattedText = "";
    const desc = baseData.description || deviceName; // Use deviceName as fallback
    const loc = baseData.location ? ` (${baseData.location})` : "";

    switch (customConfig.dataType) {
      case "boolean": {
        const displayValue = state.val
          ? customConfig.booleanTrueValue || "true"
          : customConfig.booleanFalseValue || "false";
        formattedText = `${desc} ${displayValue}${loc}`;
        break;
      }

      case "number": {
        const units = customConfig.units || "";
        formattedText = `${desc}: ${state.val}${units}${loc}`;
        break;
      }

      default:
        formattedText = `${desc}: ${state.val}${loc}`;
        if (customConfig.additionalText) {
          formattedText += ` - ${customConfig.additionalText}`;
        }
        break;
    }

    // Include device name and ID in the text for better search
    const searchableText = `${formattedText} ${deviceName} ${id}`.trim();

    return { ...baseData, formattedText: searchableText };
  }

  /**
   * Generate embedding vector for text using OpenWebUI API
   *
   * @param {string} text - Text to generate embedding for
   * @param {string} openWebUIUrl - OpenWebUI server URL
   * @param {object} log - Logger instance
   * @param {string} embeddingModel - Model name for embeddings
   * @param {string} apiKey - API key for authentication
   * @returns {Promise<Array>} Embedding vector
   */
  static async generateEmbedding(
    text,
    openWebUIUrl,
    log,
    embeddingModel = "nomic-embed-text",
    apiKey = "",
  ) {
    try {
      const headers = this._buildHeaders(apiKey);

      // Try OpenWebUI embeddings API first
      let response;
      try {
        // Ensure model name includes :latest suffix for OpenWebUI compatibility
        const openWebUIModel = embeddingModel.includes(":")
          ? embeddingModel
          : `${embeddingModel}:latest`;
        response = await axios.post(
          `${openWebUIUrl}/api/embeddings`,
          {
            model: openWebUIModel,
            input: text,
          },
          { headers, timeout: 30000 },
        );

        // Check for OpenWebUI format
        if (response.data?.data?.[0]?.embedding) {
          log.debug(
            `[VectorDB] Successfully generated embedding using OpenWebUI`,
          );
          return response.data.data[0].embedding;
        }
      } catch (openWebUIError) {
        // Detailed error analysis for OpenWebUI connection
        const errorDetails = {
          status: openWebUIError.response?.status || "No response",
          statusText: openWebUIError.response?.statusText || "Unknown",
          data: openWebUIError.response?.data || "No error data",
          code: openWebUIError.code || "No error code",
        };

        log.error(
          `[VectorDB] OpenWebUI embeddings API failed (${errorDetails.status} ${errorDetails.statusText}): ${openWebUIError.message}`,
        );

        if (errorDetails.status === 403) {
          log.error(
            `[VectorDB] OpenWebUI requires authentication - API key needed for embeddings endpoint`,
          );
        } else if (errorDetails.status === 500) {
          log.error(
            `[VectorDB] OpenWebUI internal server error - check OpenWebUI service status`,
          );
        } else if (errorDetails.code === "ECONNREFUSED") {
          log.error(
            `[VectorDB] Cannot connect to OpenWebUI at ${openWebUIUrl} - service may be down`,
          );
        }

        log.error(
          `[VectorDB] Embedding generation failed - VectorDB functionality requires working OpenWebUI connection`,
        );

        // No fallback to Ollama - embeddings only make sense with OpenWebUI/VectorDB
        throw new Error(
          `OpenWebUI embeddings API failed: ${openWebUIError.message}. VectorDB functionality disabled.`,
        );
      }

      throw new Error("No embeddings returned from API");
    } catch (error) {
      log.error(`[VectorDB] Error generating embedding: ${error.message}`);
      throw error;
    }
  }

  /**
   * Build HTTP headers for API requests
   *
   * @param {string} apiKey - API key for authentication
   * @returns {object} HTTP headers object
   */
  static _buildHeaders(apiKey = "") {
    const headers = { "Content-Type": "application/json" };

    // Only add authorization header if apiKey is a valid non-empty string
    if (apiKey && typeof apiKey === "string" && apiKey.trim().length > 0) {
      // Clean the API key to remove any invalid characters
      let cleanApiKey = apiKey
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
   * Send data to Qdrant vector database
   *
   * @param {object} data - Data object to store
   * @param {string} qdrantUrl - Qdrant server URL
   * @param {string} collectionName - Collection name for storage
   * @param {object} log - Logger instance
   * @returns {Promise<void>}
   */
  static async sendToQdrant(
    data,
    qdrantUrl,
    collectionName = "iobroker_datapoints",
    log,
  ) {
    const client = new QdrantClient({ url: qdrantUrl });

    try {
      await this.ensureCollection(client, collectionName, log);
      const pointId = this.generatePointId(data.id, data.timestamp);

      const point = {
        id: pointId,
        vector: data.embedding,
        payload: {
          datapoint_id: data.id, // GitHub Version: datapoint_id
          timestamp: data.timestamp,
          value: data.value,
          description: data.description,
          location: data.location,
          dataType: data.dataType,
          formatted_text: data.formattedText, // GitHub Version: formatted_text
          allowAutoChange: data.allowAutoChange || false,
          booleanTrueValue: data.booleanTrueValue,
          booleanFalseValue: data.booleanFalseValue,
          deviceName: data.deviceName, // Enhanced: device name for better search
          deviceChannel: data.deviceChannel, // Enhanced: device channel
        },
      };

      await client.upsert(collectionName, {
        wait: true,
        points: [point],
      });
    } catch (error) {
      log.error(`[VectorDB] Error storing data in Qdrant: ${error.message}`);
      throw error;
    }
  }

  /**
   * Ensure collection exists in Qdrant database
   *
   * @param {object} client - Qdrant client instance
   * @param {string} collectionName - Name of the collection to ensure
   * @param {object} log - Logger instance
   * @returns {Promise<void>}
   */
  static async ensureCollection(client, collectionName, log) {
    try {
      const collections = await client.getCollections();
      const exists = collections.collections.some(
        (c) => c.name === collectionName,
      );

      if (!exists) {
        await client.createCollection(collectionName, {
          vectors: { size: 768, distance: "Cosine" },
        });
        log.debug(`[VectorDB] Collection ${collectionName} created`);
      }
    } catch (error) {
      log.error(`[VectorDB] Error ensuring collection: ${error.message}`);
      throw error;
    }
  }

  /**
   * Generate unique point ID for vector database
   *
   * @param {string} datapointId - Datapoint identifier
   * @param {string} timestamp - Timestamp string
   * @returns {string} Generated unique point ID
   */
  static generatePointId(datapointId, timestamp) {
    const crypto = require("crypto");
    return crypto
      .createHash("md5")
      .update(`${datapointId}_${timestamp}`)
      .digest("hex");
  }

  /**
   * Clean up duplicate entries for a datapoint in Qdrant
   *
   * @param {string} datapointId - ID of the datapoint to clean
   * @param {string} qdrantUrl - Qdrant server URL
   * @param {string} collectionName - Collection name
   * @param {object} log - Logger instance
   * @returns {Promise<void>}
   */
  static async cleanupDuplicateEntries(
    datapointId,
    qdrantUrl,
    collectionName = "iobroker_datapoints",
    log,
  ) {
    const client = new QdrantClient({ url: qdrantUrl });

    try {
      const searchResult = await client.scroll(collectionName, {
        filter: {
          must: [{ key: "datapoint_id", match: { value: datapointId } }],
        },
        limit: 1000,
      });

      if (searchResult.points.length <= 1) {
        return;
      }

      // Sort by timestamp (newest first) and keep only the latest
      const sortedPoints = searchResult.points.sort((a, b) => {
        const aTime = a.payload?.timestamp
          ? new Date(String(a.payload.timestamp)).getTime()
          : 0;
        const bTime = b.payload?.timestamp
          ? new Date(String(b.payload.timestamp)).getTime()
          : 0;
        return bTime - aTime;
      });

      const pointsToDelete = sortedPoints.slice(1);

      if (pointsToDelete.length > 0) {
        const idsToDelete = pointsToDelete.map((p) => p.id);
        await client.delete(collectionName, {
          wait: true,
          points: idsToDelete,
        });
        log.debug(
          `[VectorDB] Deleted ${pointsToDelete.length} duplicate entries for ${datapointId}`,
        );
      }
    } catch (error) {
      log.error(
        `[VectorDB] Error cleaning up duplicates for ${datapointId}: ${error.message}`,
      );
    }
  }

  /**
   * Clean up duplicate entries for all enabled datapoints
   *
   * @param {Set} enabledDatapoints - Set of enabled datapoint IDs
   * @param {string} qdrantUrl - Qdrant server URL
   * @param {string} collectionName - Collection name
   * @param {object} log - Logger instance
   * @returns {Promise<void>}
   */
  static async cleanupAllDuplicates(
    enabledDatapoints,
    qdrantUrl,
    collectionName = "iobroker_datapoints",
    log,
  ) {
    if (!enabledDatapoints?.size) {
      log.warn("[VectorDB] No enabled datapoints found for cleanup");
      return;
    }

    let totalCleaned = 0;
    log.info(
      "[VectorDB] Starting cleanup of duplicate entries for all datapoints...",
    );

    // Use cleanupDuplicateEntries for consistent logic
    for (const datapointId of enabledDatapoints) {
      try {
        await this.cleanupDuplicateEntries(
          datapointId,
          qdrantUrl,
          collectionName,
          log,
        );
        totalCleaned++;
      } catch (error) {
        log.error(
          `[VectorDB] Error cleaning up duplicates for ${datapointId}: ${error.message}`,
        );
      }
    }

    log.info(`[VectorDB] Cleanup completed for ${totalCleaned} datapoints`);
  }

  /**
   * Clean up entries for disabled datapoints from vector database
   *
   * @param {Set} enabledDatapoints - Set of currently enabled datapoint IDs
   * @param {string} qdrantUrl - Qdrant server URL
   * @param {string} collectionName - Collection name
   * @param {object} log - Logger instance
   * @returns {Promise<number>} Number of disabled datapoints cleaned up
   */
  static async cleanupDisabledDatapoints(
    enabledDatapoints,
    qdrantUrl,
    collectionName = "iobroker_datapoints",
    log,
  ) {
    const client = new QdrantClient({ url: qdrantUrl });
    let cleanedCount = 0;

    try {
      // Get all datapoint IDs from the vector database
      const scrollResult = await client.scroll(collectionName, {
        limit: 1000,
        with_payload: ["datapoint_id"],
      });

      if (!scrollResult.points || scrollResult.points.length === 0) {
        log.info("[VectorDB] No datapoints found in vector database");
        return 0;
      }

      // Collect all datapoint IDs in the database
      const dbDatapoints = new Set();
      scrollResult.points.forEach((point) => {
        if (point.payload?.datapoint_id) {
          dbDatapoints.add(point.payload.datapoint_id);
        }
      });

      log.info(
        `[VectorDB] Found ${dbDatapoints.size} unique datapoints in vector database`,
      );
      log.info(
        `[VectorDB] Currently ${enabledDatapoints.size} datapoints are enabled`,
      );

      // Find datapoints that are in DB but not enabled anymore
      const disabledDatapoints = [];
      for (const datapointId of dbDatapoints) {
        if (!enabledDatapoints.has(datapointId)) {
          disabledDatapoints.push(datapointId);
        }
      }

      if (disabledDatapoints.length === 0) {
        log.info("[VectorDB] No disabled datapoints found to clean up");
        return 0;
      }

      log.info(
        `[VectorDB] Found ${disabledDatapoints.length} disabled datapoints to clean up: ${disabledDatapoints.join(", ")}`,
      );

      // Delete all entries for each disabled datapoint
      for (const datapointId of disabledDatapoints) {
        try {
          // First, get all points for this datapoint (like in cleanupDuplicateEntries)
          const searchResult = await client.scroll(collectionName, {
            filter: {
              must: [{ key: "datapoint_id", match: { value: datapointId } }],
            },
            limit: 1000,
          });

          if (searchResult.points.length > 0) {
            // Delete by specific point IDs (this approach works)
            const idsToDelete = searchResult.points.map((p) => p.id);
            await client.delete(collectionName, {
              wait: true,
              points: idsToDelete,
            });

            log.debug(
              `[VectorDB] Removed ${searchResult.points.length} entries for disabled datapoint: ${datapointId}`,
            );
          }

          cleanedCount++;
        } catch (error) {
          log.error(
            `[VectorDB] Error removing entries for ${datapointId}: ${error.message}`,
          );
        }
      }

      log.info(
        `[VectorDB] Successfully cleaned up ${cleanedCount} disabled datapoints`,
      );
      return cleanedCount;
    } catch (error) {
      log.error(
        `[VectorDB] Error during disabled datapoints cleanup: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Complete vector database cleanup - removes duplicates and disabled datapoints
   *
   * @param {Set} enabledDatapoints - Set of enabled datapoint IDs
   * @param {string} qdrantUrl - Qdrant server URL
   * @param {string} collectionName - Collection name
   * @param {object} log - Logger instance
   * @returns {Promise<object>} Cleanup results summary
   */
  static async completeVectorDbCleanup(
    enabledDatapoints,
    qdrantUrl,
    collectionName = "iobroker_datapoints",
    log,
  ) {
    log.info("[VectorDB] Starting complete vector database cleanup...");

    let duplicatesCleanedDatapoints = 0;
    let disabledDatapointsRemoved = 0;
    let totalPointsRemaining = 0;
    const errors = [];

    try {
      // Step 1: Clean up disabled datapoints first
      log.info(
        "[VectorDB] Step 1: Removing entries for disabled datapoints...",
      );
      disabledDatapointsRemoved = await this.cleanupDisabledDatapoints(
        enabledDatapoints,
        qdrantUrl,
        collectionName,
        log,
      );

      // Step 2: Clean up duplicates for remaining enabled datapoints
      log.info(
        "[VectorDB] Step 2: Cleaning up duplicates for enabled datapoints...",
      );
      if (enabledDatapoints?.size > 0) {
        for (const datapointId of enabledDatapoints) {
          try {
            await this.cleanupDuplicateEntries(
              datapointId,
              qdrantUrl,
              collectionName,
              log,
            );
            duplicatesCleanedDatapoints++;
          } catch (error) {
            const errorMsg = `Error cleaning duplicates for ${datapointId}: ${error.message}`;
            log.error(`[VectorDB] ${errorMsg}`);
            errors.push(errorMsg);
          }
        }
      }

      // Step 3: Get final statistics
      const client = new QdrantClient({ url: qdrantUrl });
      const collectionInfo = await client.getCollection(collectionName);
      totalPointsRemaining = collectionInfo.points_count || 0;

      log.info("[VectorDB] === CLEANUP SUMMARY ===");
      log.info(
        `[VectorDB] Disabled datapoints removed: ${disabledDatapointsRemoved}`,
      );
      log.info(
        `[VectorDB] Datapoints processed for duplicates: ${duplicatesCleanedDatapoints}`,
      );
      log.info(
        `[VectorDB] Total points remaining in database: ${totalPointsRemaining}`,
      );
      log.info(`[VectorDB] Errors encountered: ${errors.length}`);

      if (errors.length > 0) {
        log.warn("[VectorDB] Errors during cleanup:");
        errors.forEach((error) => log.warn(`[VectorDB] - ${error}`));
      }

      log.info(
        "[VectorDB] Complete vector database cleanup finished successfully",
      );

      return {
        duplicatesCleanedDatapoints,
        disabledDatapointsRemoved,
        totalPointsRemaining,
        errors,
      };
    } catch (error) {
      log.error(
        `[VectorDB] Fatal error during complete cleanup: ${error.message}`,
      );
      errors.push(`Fatal error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check for existing objects with enabled embedding on startup
   *
   * @param {object} adapter - ioBroker adapter instance
   */
  static async checkExistingEmbeddingEnabled(adapter) {
    if (!adapter || !adapter.log) {
      // Use fallback logging when adapter logger is unavailable
      if (typeof console !== "undefined") {
        console.warn("[VectorDB] Invalid adapter instance provided");
      }
      return;
    }

    adapter.log.debug("Checking for existing objects with enabled features...");

    try {
      // Ensure _enabledDatapoints exists
      if (!adapter._enabledDatapoints) {
        adapter._enabledDatapoints = new Set();
      }

      const objects = await adapter.getObjectViewAsync("system", "custom", {});

      if (objects?.rows) {
        for (const row of objects.rows) {
          const id = row.id;
          const customConfig = row.value?.[adapter.namespace];

          if (customConfig) {
            const features = [];

            // Check for embedding enabled
            if (customConfig.enabled === true) {
              adapter._enabledDatapoints.add(id);
              // Only subscribe if the method exists
              if (typeof adapter.subscribeForeignStates === "function") {
                adapter.subscribeForeignStates(id);
              }
              features.push("Vector Database");
            }

            // Check for auto-change enabled
            if (customConfig.allowAutoChange === true) {
              adapter._enabledDatapoints.add(id);
              features.push("Function Calling");
            }

            if (features.length > 0) {
              adapter.log.info(
                `[Config] Datapoint ${id} configured for: ${features.join(", ")}`,
              );
            }
          }
        }
      }
    } catch (error) {
      adapter.log.error(
        `Error checking existing objects: ${error.message || error}`,
      );
    }

    const enabledCount = adapter._enabledDatapoints
      ? adapter._enabledDatapoints.size
      : 0;
    adapter.log.info(
      `[AI] Found ${enabledCount} datapoints with AI features enabled`,
    );
  }

  /**
   * Intelligent retention cleanup based on configuration
   *
   * @param {string} datapointId - ID of the datapoint to clean
   * @param {string} qdrantUrl - Qdrant server URL
   * @param {string} collectionName - Collection name
   * @param {object} config - Retention configuration
   * @param {object} log - Logger instance
   * @returns {Promise<number>} Number of entries removed
   */
  static async retentionCleanup(
    datapointId,
    qdrantUrl,
    collectionName = "iobroker_datapoints",
    config,
    log,
  ) {
    if (!config.retentionEnabled) {
      return 0;
    }

    const client = new QdrantClient({ url: qdrantUrl });
    let removedCount = 0;

    try {
      const searchResult = await client.scroll(collectionName, {
        filter: {
          must: [{ key: "datapoint_id", match: { value: datapointId } }],
        },
        limit: 1000,
      });

      if (searchResult.points.length <= 1) {
        return 0;
      }

      // Sort by timestamp (newest first)
      const sortedPoints = searchResult.points.sort((a, b) => {
        const aTime = a.payload?.timestamp
          ? new Date(String(a.payload.timestamp)).getTime()
          : 0;
        const bTime = b.payload?.timestamp
          ? new Date(String(b.payload.timestamp)).getTime()
          : 0;
        return bTime - aTime;
      });

      const pointsToDelete = [];
      const retentionTimestamp =
        Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;

      for (let i = 0; i < sortedPoints.length; i++) {
        const point = sortedPoints[i];
        const pointTime = point.payload?.timestamp
          ? new Date(String(point.payload.timestamp)).getTime()
          : 0;

        // Remove if:
        // 1. Exceeds max entries per datapoint (keep newest X entries)
        // 2. Older than retention days
        if (i >= config.retentionMaxEntries || pointTime < retentionTimestamp) {
          pointsToDelete.push(point);
        }
      }

      if (pointsToDelete.length > 0) {
        const idsToDelete = pointsToDelete.map((p) => p.id);
        await client.delete(collectionName, {
          wait: true,
          points: idsToDelete,
        });
        removedCount = pointsToDelete.length;

        log.info(
          `[VectorDB] Retention cleanup for ${datapointId}: removed ${removedCount} entries (${config.retentionDays}d retention, max ${config.retentionMaxEntries} entries)`,
        );
      }

      return removedCount;
    } catch (error) {
      log.error(
        `[VectorDB] Error during retention cleanup for ${datapointId}: ${error.message}`,
      );
      return 0;
    }
  }

  /**
   * Run retention cleanup for all enabled datapoints
   *
   * @param {Set} enabledDatapoints - Set of enabled datapoint IDs
   * @param {string} qdrantUrl - Qdrant server URL
   * @param {string} collectionName - Collection name
   * @param {object} config - Retention configuration
   * @param {object} log - Logger instance
   * @returns {Promise<object>} Cleanup results
   */
  static async runRetentionCleanup(
    enabledDatapoints,
    qdrantUrl,
    collectionName = "iobroker_datapoints",
    config,
    log,
  ) {
    if (!config.retentionEnabled) {
      log.info("[VectorDB] Retention cleanup is disabled");
      return { processed: 0, removed: 0 };
    }

    log.info(
      `[VectorDB] Starting retention cleanup for ${enabledDatapoints.size} datapoints...`,
    );

    let totalProcessed = 0;
    let totalRemoved = 0;

    for (const datapointId of enabledDatapoints) {
      try {
        const removed = await this.retentionCleanup(
          datapointId,
          qdrantUrl,
          collectionName,
          config,
          log,
        );
        totalRemoved += removed;
        totalProcessed++;
      } catch (error) {
        log.error(
          `[VectorDB] Error during retention cleanup for ${datapointId}: ${error.message}`,
        );
      }
    }

    log.info(
      `[VectorDB] Retention cleanup completed: processed ${totalProcessed} datapoints, removed ${totalRemoved} entries`,
    );

    return { processed: totalProcessed, removed: totalRemoved };
  }
}

module.exports = QdrantHelper;
