"use strict";

const { QdrantClient } = require("@qdrant/qdrant-js");
const axios = require("axios");

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
    const url = `http://${ip}:${port}`;
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
   * @param {object} config - Configuration object
   * @param {object} log - Logger instance
   * @param {Set} processedStates - Set of already processed state IDs
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

      // Simple deduplication
      const stateKey = `${id}_${state.val}_${Math.floor(state.ts / 60000)}`;
      if (processedStates.has(stateKey)) {
        return false;
      }

      processedStates.add(stateKey);

      // Cleanup old entries periodically
      if (processedStates.size > 500) {
        const entries = Array.from(processedStates);
        processedStates.clear();
        entries.slice(-250).forEach((entry) => processedStates.add(entry));
      }

      const openWebUIUrl = `http://${config.openWebUIIp}:${config.openWebUIPort}`;
      const qdrantUrl = `http://${config.vectorDbIp}:${config.vectorDbPort}`;

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

      // Periodic cleanup (5% chance)
      if (Math.random() < 0.05) {
        await this.cleanupDuplicateEntries(
          id,
          qdrantUrl,
          "iobroker_datapoints",
          log,
        );
      }
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
    };

    let formattedText = "";
    const desc = baseData.description;
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

    return { ...baseData, formattedText: formattedText.trim() };
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

      const response = await axios.post(
        `${openWebUIUrl}/ollama/api/embed`,
        {
          model: embeddingModel,
          input: text,
        },
        { headers, timeout: 30000 },
      );

      if (!response.data.embeddings?.[0]) {
        throw new Error("No embeddings returned from API");
      }

      return response.data.embeddings[0];
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
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
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
        log.info(`[VectorDB] Collection ${collectionName} created`);
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
        log.info(
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

            log.info(
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
    adapter.log.debug("Checking for existing objects with enabled features...");

    try {
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
              adapter.subscribeForeignStates(id);
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
      adapter.log.error(`Error checking existing objects: ${error}`);
    }

    adapter.log.info(
      `[AI] Found ${adapter._enabledDatapoints.size} datapoints with AI features enabled`,
    );
  }
}

module.exports = QdrantHelper;
