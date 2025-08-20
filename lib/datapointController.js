"use strict";

const OllamaClient = require("./ollamaClient");

/**
 * Datapoint Controller with ioBroker i18n support
 * Handles setting datapoint values with type conversion and validation
 */
class DatapointController {
  /**
   * Create a new DatapointController
   *
   * @param {object} adapter - The ioBroker adapter instance
   * @param {Set} allowedDatapoints - Set of allowed datapoint IDs
   * @param {object} log - Logger instance
   * @param {Function} translateFn - Translation function
   * @param {object} qdrantClient - Qdrant client for vector database operations (optional)
   * @param {object} config - Adapter configuration for vector database (optional)
   */
  constructor(
    adapter,
    allowedDatapoints = new Set(),
    log = console,
    translateFn = (key) => key,
    qdrantClient = null,
    config = null,
  ) {
    this.adapter = adapter;
    this.allowedDatapoints = allowedDatapoints; // For reading (getState)
    this.writeAllowedDatapoints = new Set(); // For writing (setState) - more restrictive
    this.log = log;
    this.translate = translateFn;
    this.datapointMapping = new Map(); // Maps short names to full IDs

    // Vector database integration for enhanced datapoint resolution
    this.qdrantClient = qdrantClient;
    this.config = config;
    this.collectionName = config?.vectorDbCollection || "iobroker_datapoints";

    this.log.info(
      this.translate("general_initialized").replace(
        "{{component}}",
        "DatapointController",
      ),
    );
  }

  /**
   * Set allowed datapoints for reading (getState)
   *
   * @param {Set} allowedDatapoints - Set of allowed datapoint IDs for reading
   */
  setAllowedDatapoints(allowedDatapoints) {
    this.allowedDatapoints = allowedDatapoints;
    this._buildDatapointMapping();
    this.log.debug(
      `[DatapointController] Updated allowed datapoints for reading: ${allowedDatapoints.size} datapoints`,
    );
  }

  /**
   * Set allowed datapoints for writing (setState)
   *
   * @param {Set} writeAllowedDatapoints - Set of allowed datapoint IDs for writing
   */
  setWriteAllowedDatapoints(writeAllowedDatapoints) {
    this.writeAllowedDatapoints = writeAllowedDatapoints;
    this.log.info(
      `[DatapointController] Updated allowed datapoints for writing: ${writeAllowedDatapoints.size} datapoints`,
    );
    this.log.debug(
      `[DatapointController] Write-allowed datapoints: ${Array.from(writeAllowedDatapoints).join(", ")}`,
    );
  }

  /**
   * Build mapping from short names to full datapoint IDs
   */
  _buildDatapointMapping() {
    this.datapointMapping.clear();

    for (const fullId of this.allowedDatapoints) {
      // Extract the part after the last dot as short name
      const parts = fullId.split(".");
      const shortName = parts[parts.length - 1];

      // Store both the short name and variations
      this.datapointMapping.set(shortName, fullId);
      this.datapointMapping.set(shortName.toLowerCase(), fullId);

      // Also map with spaces instead of underscores
      const spacedName = shortName.replace(/_/g, " ");
      this.datapointMapping.set(spacedName, fullId);
      this.datapointMapping.set(spacedName.toLowerCase(), fullId);

      this.log.debug(
        `[DatapointController] Mapped "${shortName}" -> "${fullId}"`,
      );
    }
  }

  /**
   * Resolve datapoint ID using vector database for semantic matching
   * Uses embedding similarity to find the best matching datapoint
   *
   * @param {string} inputDatapoint - Input datapoint name/ID
   * @returns {Promise<string|null>} Resolved datapoint ID or null
   */
  async _resolveWithVectorDatabase(inputDatapoint) {
    try {
      // Generate embedding for the input query using ToolServer's method
      const QdrantHelper = require("./qdrantClient");

      // Generate embedding for the input
      const openWebUIUrl = OllamaClient.createHttpUrl(
        this.config.openWebUIIp,
        this.config.openWebUIPort,
      );
      const embedding = await QdrantHelper.generateEmbedding(
        inputDatapoint,
        openWebUIUrl,
        this.log,
        this.config.embeddingModel || "nomic-embed-text",
        this.config.openWebUIApiKey || "",
      );

      // Search for similar datapoints in vector database
      const searchResults = await this.qdrantClient.search(
        this.collectionName,
        {
          vector: embedding,
          limit: 10, // Increased for better matching
          with_payload: true,
          filter: {
            must: [
              {
                key: "datapoint_id",
                match: {
                  any: Array.from(this.allowedDatapoints), // Only search within allowed datapoints
                },
              },
            ],
          },
        },
      );

      if (!searchResults || searchResults.length === 0) {
        this.log.debug(
          `[DatapointController] No vector matches found for "${inputDatapoint}"`,
        );
        return null;
      }

      // Enhanced matching - check for multiple criteria
      for (const match of searchResults) {
        const datapointId = match.payload?.datapoint_id;
        const similarity = match.score;
        const deviceName = match.payload?.deviceName || "";
        const description = match.payload?.description || "";
        const location = match.payload?.location || "";

        if (!datapointId || !this.isDatapointReadAllowed(datapointId)) {
          continue;
        }

        // Enhanced matching logic with multiple criteria
        const inputLower = inputDatapoint.toLowerCase();
        const deviceNameLower = deviceName.toLowerCase();
        const descriptionLower = description.toLowerCase();
        const locationLower = location.toLowerCase();

        // Check for direct name matches with high priority
        if (
          deviceNameLower.includes(inputLower) ||
          inputLower.includes(deviceNameLower)
        ) {
          this.log.debug(
            `[DatapointController] Vector device name match: "${inputDatapoint}" -> "${datapointId}" (device: ${deviceName}, similarity: ${similarity.toFixed(3)})`,
          );
          return datapointId;
        }

        // Check for description/location matches with medium priority
        if (
          similarity > 0.6 &&
          (descriptionLower.includes(inputLower) ||
            locationLower.includes(inputLower) ||
            inputLower.includes(descriptionLower) ||
            inputLower.includes(locationLower))
        ) {
          this.log.debug(
            `[DatapointController] Vector description/location match: "${inputDatapoint}" -> "${datapointId}" (desc: ${description}, loc: ${location}, similarity: ${similarity.toFixed(3)})`,
          );
          return datapointId;
        }

        // High similarity match as fallback
        if (similarity > 0.8) {
          this.log.debug(
            `[DatapointController] Vector high similarity match: "${inputDatapoint}" -> "${datapointId}" (similarity: ${similarity.toFixed(3)})`,
          );
          return datapointId;
        }
      }

      this.log.debug(
        `[DatapointController] No suitable vector matches found for "${inputDatapoint}" - checked ${searchResults.length} results`,
      );
      return null;
    } catch (error) {
      this.log.warn(
        `[DatapointController] Vector database search error: ${error.message}`,
      );
      return null;
    }
  }

  /**
   * Find the correct datapoint ID from various input formats
   * Enhanced with vector database search for better semantic matching
   *
   * @param {string} inputDatapoint - Input datapoint name/ID
   * @returns {Promise<string|null>} Full datapoint ID or null if not found
   */
  async _resolveDatapointId(inputDatapoint) {
    if (!inputDatapoint) {
      return null;
    }

    // First, check if it's already a full ID
    if (this.isDatapointReadAllowed(inputDatapoint)) {
      return inputDatapoint;
    }

    // Check direct mapping
    if (this.datapointMapping.has(inputDatapoint)) {
      return this.datapointMapping.get(inputDatapoint);
    }

    // Check lowercase mapping
    const lowerInput = inputDatapoint.toLowerCase();
    if (this.datapointMapping.has(lowerInput)) {
      return this.datapointMapping.get(lowerInput);
    }

    // Fuzzy matching - find datapoint that contains the input
    for (const [shortName, fullId] of this.datapointMapping.entries()) {
      if (
        shortName.toLowerCase().includes(lowerInput) ||
        lowerInput.includes(shortName.toLowerCase())
      ) {
        this.log.debug(
          `[DatapointController] Fuzzy matched "${inputDatapoint}" -> "${fullId}"`,
        );
        return fullId;
      }
    }

    // Enhanced partial matching on full IDs - split input into words for better matching
    const inputWords = lowerInput
      .split(/[\s_\-.]+/)
      .filter((word) => word.length > 2);

    for (const fullId of this.allowedDatapoints) {
      const lowerFullId = fullId.toLowerCase();

      // Check if full ID contains the input
      if (lowerFullId.includes(lowerInput)) {
        this.log.debug(
          `[DatapointController] Partial matched "${inputDatapoint}" -> "${fullId}"`,
        );
        return fullId;
      }

      // Check if all meaningful words from input are present in the full ID
      if (inputWords.length > 0) {
        const matchingWords = inputWords.filter((word) =>
          lowerFullId.includes(word),
        );
        if (matchingWords.length === inputWords.length) {
          this.log.debug(
            `[DatapointController] Word-based matched "${inputDatapoint}" -> "${fullId}" (matched words: ${matchingWords.join(", ")})`,
          );
          return fullId;
        }
      }
    }

    // Vector database enhanced resolution if available
    if (this.qdrantClient && this.config?.useVectorDb) {
      this.log.debug(
        `[DatapointController] Attempting vector database resolution for "${inputDatapoint}"`,
      );

      try {
        const vectorResult =
          await this._resolveWithVectorDatabase(inputDatapoint);
        if (vectorResult) {
          this.log.info(
            `[DatapointController] Vector database resolved "${inputDatapoint}" -> "${vectorResult}"`,
          );
          return vectorResult;
        }
      } catch (error) {
        this.log.warn(
          `[DatapointController] Vector database resolution failed for "${inputDatapoint}": ${error.message}`,
        );
      }
    }

    return null;
  }

  /**
   * Get current datapoint value
   *
   * @param {string} datapointId - Datapoint ID
   * @returns {Promise<object>} Result object with success status and value
   */
  async getDatapointValue(datapointId) {
    try {
      // Check if datapoint is allowed for reading
      if (!this.isDatapointReadAllowed(datapointId)) {
        this.log.warn(
          `[DatapointController] Datapoint ${datapointId} is not allowed for reading`,
        );
        return {
          success: false,
          error: `Datapoint not allowed for reading: ${datapointId}`,
          datapointId: datapointId,
        };
      }

      const state = await this.adapter.getForeignStateAsync(datapointId);
      if (state) {
        return {
          success: true,
          value: state.val,
          timestamp: state.ts,
          datapointId: datapointId,
        };
      }
      return {
        success: false,
        error: "Datapoint not found or no value",
        datapointId: datapointId,
      };
    } catch (error) {
      this.log.error(
        `[DatapointController] Error getting value for ${datapointId}: ${error.message}`,
      );
      return {
        success: false,
        error: error.message,
        datapointId: datapointId,
      };
    }
  }

  /**
   * Check if a datapoint is allowed for reading
   *
   * @param {string} datapointId - Datapoint ID to check
   * @returns {boolean} True if allowed for reading
   */
  isDatapointReadAllowed(datapointId) {
    return (
      this.allowedDatapoints.size === 0 ||
      this.allowedDatapoints.has(datapointId)
    );
  }

  /**
   * Check if a datapoint is allowed for writing
   *
   * @param {string} datapointId - Datapoint ID to check
   * @returns {boolean} True if allowed for writing
   */
  isDatapointWriteAllowed(datapointId) {
    return this.writeAllowedDatapoints.has(datapointId);
  }

  /**
   * Convert value to appropriate type with localized support
   *
   * @param {*} value - Input value
   * @param {string} targetType - Target data type
   * @param {object} customConfig - Custom configuration
   * @returns {*} Converted value or null if conversion failed
   */
  convertValue(value, targetType, customConfig = {}) {
    try {
      // Handle null/undefined values - try to infer from context
      if (value === null || value === undefined) {
        this.log.debug(
          `[DatapointController] Null value received for type ${targetType}, attempting smart conversion`,
        );
        return this._handleNullValue(targetType, customConfig);
      }

      switch (targetType) {
        case "boolean": {
          const boolResult = this.convertToBoolean(value, customConfig);
          if (
            boolResult === null &&
            (customConfig.booleanTrueValue || customConfig.booleanFalseValue)
          ) {
            // Failed to match custom values, don't convert
            this.log.error(
              `[DatapointController] Boolean conversion failed: "${value}" doesn't match custom values`,
            );
            return null;
          }
          return boolResult;
        }

        case "number":
          return this.convertToNumber(value, customConfig);

        case "text":
        case "string":
        default:
          return this.convertToString(value, customConfig);
      }
    } catch (_error) {
      this.log.warn(
        this.translate("datapoint_type_conversion_failed")
          .replace("{{value}}", value)
          .replace("{{type}}", targetType),
      );
      return null; // Return null instead of original value to indicate failed conversion
    }
  }

  /**
   * Handle null values by inferring appropriate defaults
   *
   * @param {string} targetType - Target data type
   * @param {object} customConfig - Custom configuration
   * @returns {*} Inferred value based on context
   */
  _handleNullValue(targetType, customConfig = {}) {
    switch (targetType) {
      case "boolean":
        // For presence datapoints, default to true (person is home)
        if (customConfig.isPresenceDatapoint) {
          this.log.debug(
            "[DatapointController] Inferring boolean true for presence datapoint",
          );
          return true;
        }
        return false;

      case "number":
        return 0;

      case "text":
      case "string":
      default:
        return "";
    }
  }

  /**
   * Convert to boolean using primarily custom configuration values
   *
   * @param {*} value - Input value
   * @param {object} customConfig - Custom configuration
   * @returns {boolean|null} Boolean value or null if conversion failed
   */
  convertToBoolean(value, customConfig = {}) {
    // For custom boolean values, always convert, even if value is already boolean
    if (
      typeof value === "boolean" &&
      !(customConfig.booleanTrueValue || customConfig.booleanFalseValue)
    ) {
      // Only return boolean directly if NO custom values are defined
      return value;
    }

    const valueStr = String(value).toLowerCase().trim();

    // If custom boolean values are defined, use them as primary parsing reference
    if (customConfig.booleanTrueValue || customConfig.booleanFalseValue) {
      return this._parseWithCustomValues(valueStr, customConfig);
    }

    // Fallback for datapoints without custom values - use minimal universal parsing
    return this._parseUniversalBoolean(valueStr);
  }

  /**
   * Parse boolean using custom configuration values as reference
   *
   * @param {string} valueStr - Lowercase trimmed string value
   * @param {object} customConfig - Custom configuration with booleanTrueValue/booleanFalseValue
   * @returns {boolean|null} Boolean value or null if conversion failed
   */
  _parseWithCustomValues(valueStr, customConfig) {
    // Special handling for boolean values converted to string
    if (valueStr === "true" || valueStr === "false") {
      const boolVal = valueStr === "true";
      const customValue = boolVal
        ? customConfig.booleanTrueValue || true
        : customConfig.booleanFalseValue || false;

      this.log.debug(
        `[DatapointController] Boolean string conversion: "${valueStr}" -> ${customValue}`,
      );
      return customValue;
    }

    // Step 1: Direct exact match with custom values
    if (customConfig.booleanTrueValue) {
      const trueValue = String(customConfig.booleanTrueValue)
        .toLowerCase()
        .trim();
      if (valueStr === trueValue) {
        this.log.debug(
          `[DatapointController] Exact match custom true: "${valueStr}" -> ${customConfig.booleanTrueValue}`,
        );
        return customConfig.booleanTrueValue; // Return actual custom value
      }
    }

    if (customConfig.booleanFalseValue) {
      const falseValue = String(customConfig.booleanFalseValue)
        .toLowerCase()
        .trim();
      if (valueStr === falseValue) {
        this.log.debug(
          `[DatapointController] Exact match custom false: "${valueStr}" -> ${customConfig.booleanFalseValue}`,
        );
        return customConfig.booleanFalseValue; // Return actual custom value
      }
    }

    // Step 2: Partial/fuzzy match with custom values
    if (customConfig.booleanTrueValue) {
      const trueValue = String(customConfig.booleanTrueValue)
        .toLowerCase()
        .trim();
      if (valueStr.includes(trueValue) || trueValue.includes(valueStr)) {
        this.log.debug(
          `[DatapointController] Fuzzy match custom true: "${valueStr}" contains/matches "${trueValue}" -> ${customConfig.booleanTrueValue}`,
        );
        return customConfig.booleanTrueValue; // Return actual custom value
      }
    }

    if (customConfig.booleanFalseValue) {
      const falseValue = String(customConfig.booleanFalseValue)
        .toLowerCase()
        .trim();
      if (valueStr.includes(falseValue) || falseValue.includes(valueStr)) {
        this.log.debug(
          `[DatapointController] Fuzzy match custom false: "${valueStr}" contains/matches "${falseValue}" -> ${customConfig.booleanFalseValue}`,
        );
        return customConfig.booleanFalseValue; // Return actual custom value
      }
    }

    // Step 3: Try to infer from universal boolean values and map to custom values
    const universalResult = this._parseUniversalBoolean(valueStr);
    if (universalResult !== null) {
      // For custom values, return the appropriate custom value, not the boolean!
      const customValue = universalResult
        ? customConfig.booleanTrueValue || true
        : customConfig.booleanFalseValue || false;

      this.log.debug(
        `[DatapointController] Universal boolean conversion: "${valueStr}" -> ${customValue} (interpreted as ${universalResult})`,
      );
      return customValue; // Return custom value, not boolean!
    }

    // Step 4: Could not parse - log detailed information
    this.log.warn(
      `[DatapointController] Cannot parse "${valueStr}" as boolean. Expected values: true="${customConfig.booleanTrueValue}", false="${customConfig.booleanFalseValue}", or universal values (true/false, 1/0)`,
    );
    return null;
  }

  /**
   * Parse universal boolean values (minimal fallback)
   *
   * @param {string} valueStr - Lowercase trimmed string value
   * @returns {boolean|null} Boolean value or null if parsing failed
   */
  _parseUniversalBoolean(valueStr) {
    // Only the most universal boolean representations
    const universalTrue = ["true", "1", "yes", "ja"];
    const universalFalse = ["false", "0", "no", "nein"];

    if (universalTrue.includes(valueStr)) {
      return true;
    }
    if (universalFalse.includes(valueStr)) {
      return false;
    }

    // Numeric conversion as last resort
    if (!isNaN(Number(valueStr))) {
      return Number(valueStr) !== 0;
    }

    return null;
  }

  /**
   * Convert to number
   *
   * @param {*} value - Input value
   * @param {object} _customConfig - Custom configuration
   * @returns {number} Number value
   */
  convertToNumber(value, _customConfig) {
    if (typeof value === "number") {
      return value;
    }

    if (typeof value === "string") {
      const numMatch = value.match(/(-?\d+(?:[.,]\d+)?)/);
      if (numMatch) {
        return parseFloat(numMatch[1].replace(",", "."));
      }
    }

    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }

    return 0;
  }

  /**
   * Convert to string with localized boolean representation
   *
   * @param {*} value - Input value
   * @param {object} _customConfig - Custom configuration
   * @returns {string} String value
   */
  convertToString(value, _customConfig) {
    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "boolean") {
      return value
        ? this.translate("datapoint_boolean_true")
        : this.translate("datapoint_boolean_false");
    }

    return String(value);
  }

  /**
   * Get enhanced function definitions with object information for AI Function Calling
   * This method fetches object definitions to provide accurate type and value information
   *
   * @returns {Promise<Array>} Array of function definitions with detailed datapoint info
   */
  async getEnhancedFunctionDefinitions() {
    if (this.allowedDatapoints.size === 0) {
      this.log.debug(
        "[DatapointController] No allowed datapoints available for function definitions",
      );
      return [];
    }

    // Get detailed datapoint information including object definitions
    const datapointInfos = [];

    for (const fullId of this.allowedDatapoints) {
      try {
        const obj = await this.adapter.getForeignObjectAsync(fullId);
        if (obj && obj.common) {
          const shortName = fullId.split(".").pop();
          let info = `${shortName} (${fullId}, type: ${obj.common.type}`;

          // Add custom states info for boolean datapoints
          if (obj.common.states && Object.keys(obj.common.states).length > 0) {
            const states = Object.entries(obj.common.states)
              .map(([key, value]) => `${key}="${value}"`)
              .join(", ");
            info += `, custom values: ${states}`;
          }

          // Add unit for number datapoints
          if (obj.common.type === "number" && obj.common.unit) {
            info += `, unit: ${obj.common.unit}`;
          }

          // Add min/max for number datapoints
          if (obj.common.type === "number") {
            if (obj.common.min !== undefined) {
              info += `, min: ${obj.common.min}`;
            }
            if (obj.common.max !== undefined) {
              info += `, max: ${obj.common.max}`;
            }
          }

          info += ")";
          datapointInfos.push(info);
        } else {
          // Fallback if object not found
          const shortName = fullId.split(".").pop();
          datapointInfos.push(`${shortName} (${fullId})`);
        }
      } catch (error) {
        this.log.debug(
          `[DatapointController] Error fetching object ${fullId}: ${error.message}`,
        );
        const shortName = fullId.split(".").pop();
        datapointInfos.push(`${shortName} (${fullId})`);
      }
    }

    const datapointList = datapointInfos.join(", ");

    return [
      {
        type: "function",
        function: {
          name: "setState",
          description: `Set the state of an ioBroker datapoint to control smart home devices. IMPORTANT: Use the exact values expected by each datapoint type:
- For boolean datapoints with custom values, use the exact custom text (e.g., "Anwesend" not true)
- For number datapoints, use numeric values respecting min/max limits
- For string datapoints, use string values
- For selection lists, use one of the allowed values exactly as specified
Do NOT convert values - use them exactly as the datapoint expects. Available datapoints: ${datapointList}`,
          parameters: {
            type: "object",
            properties: {
              datapoint: {
                type: "string",
                description: "The name or ID of the datapoint to control",
              },
              value: {
                type: ["boolean", "number", "string"],
                description:
                  "The exact value to set - must match the datapoint's expected format (custom text for boolean with custom values, numbers for numeric datapoints, etc.)",
              },
            },
            required: ["datapoint", "value"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getState",
          description: `Get the current state of an ioBroker datapoint. Returns the actual value as stored in ioBroker. Available datapoints: ${datapointList}`,
          parameters: {
            type: "object",
            properties: {
              datapoint: {
                type: "string",
                description: "The name or ID of the datapoint to read",
              },
            },
            required: ["datapoint"],
          },
        },
      },
    ];
  }

  /**
   * Get function definitions for AI Function Calling (OpenAI-compatible)
   * Returns tools/functions that AI models can directly invoke
   *
   * @returns {Array} Array of function definitions
   */
  getFunctionDefinitions() {
    if (this.allowedDatapoints.size === 0) {
      return [];
    }

    // Create readable datapoint list for LLM with custom values
    const datapointList = Array.from(this.allowedDatapoints)
      .map((fullId) => {
        const parts = fullId.split(".");
        const shortName = parts[parts.length - 1];
        return `${shortName} (${fullId})`;
      })
      .join(", ");

    return [
      {
        type: "function",
        function: {
          name: "setState",
          description: `Set the state of an ioBroker datapoint to control smart home devices. The system automatically converts between different value formats (true/false, 1/0, custom words). For boolean datapoints with custom values, you can use either standard boolean values (true/false, 1/0, yes/no, ja/nein) or the custom words. For temperature datapoints like 'Temperatur_Wohnzimmer', this sets the actual temperature value, not heating control. You can use either the short name (e.g., 'Anwesenheit_Martin') or full ID. Available datapoints: ${datapointList}`,
          parameters: {
            type: "object",
            properties: {
              datapoint: {
                type: "string",
                description:
                  "The name or ID of the datapoint to control. Examples: 'Anwesenheit_Martin' for presence, 'Temperatur_Wohnzimmer' for room temperature value",
              },
              value: {
                type: ["boolean", "number", "string"],
                description:
                  "The new value to set. For boolean datapoints you can use: true/false, 1/0, yes/no, ja/nein, on/off, ein/aus, or any custom words defined for that datapoint. The system will automatically convert between formats. For temperature datapoints use numbers (e.g., 23.5)",
              },
            },
            required: ["datapoint", "value"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getState",
          description: `Get the current state of an ioBroker datapoint. For calculations like averages, call this function multiple times or use RAG context data to get historical values, then calculate yourself. Available datapoints: ${datapointList}`,
          parameters: {
            type: "object",
            properties: {
              datapoint: {
                type: "string",
                description:
                  "The name or ID of the datapoint to read. You can use short names like 'Anwesenheit_Martin' or 'Temperatur_Wohnzimmer'",
              },
            },
            required: ["datapoint"],
          },
        },
      },
    ];
  }

  /**
   * Execute a function call from AI Function Calling
   *
   * @param {string} functionName - Name of the function to execute
   * @param {object} parameters - Parameters for the function
   * @returns {Promise<object>} Result of the function execution
   */
  async executeFunctionCall(functionName, parameters) {
    this.log.info(
      `[DatapointController] Executing function call: ${functionName} with parameters:`,
      parameters,
    );

    switch (functionName) {
      case "setState":
        // Use new direct approach inspired by ai-assistant adapter
        return await this.executeSetStateDirectly(parameters);
      case "getState":
        return await this.executeGetState(parameters);
      // Legacy compatibility
      case "set_datapoint":
        return await this.executeSetStateDirectly({
          datapoint: parameters.datapoint,
          value: parameters.value,
        });
      default:
        throw new Error(`Unknown function: ${functionName}`);
    }
  }

  /**
   * Execute setState function with direct value setting (no conversion)
   * This is the new approach inspired by ai-assistant adapter
   *
   * @param {object} parameters - Function parameters
   * @returns {Promise<object>} Result of the operation
   */
  async executeSetStateDirectly(parameters) {
    const { datapoint, value } = parameters;

    if (!datapoint) {
      return {
        success: false,
        error: "Missing required parameter: datapoint",
      };
    }

    if (value === undefined || value === null) {
      return {
        success: false,
        error: "Missing required parameter: value",
      };
    }

    // Resolve the datapoint ID (now async)
    const resolvedDatapoint = await this._resolveDatapointId(datapoint);
    if (!resolvedDatapoint) {
      return {
        success: false,
        error: `Datapoint not found or not allowed: ${datapoint}`,
      };
    }

    this.log.debug(
      `[DatapointController] Resolved "${datapoint}" -> "${resolvedDatapoint}"`,
    );

    try {
      // Check if datapoint is allowed for writing
      if (!this.isDatapointWriteAllowed(resolvedDatapoint)) {
        return {
          success: false,
          error: `Datapoint not allowed for writing (allowAutoChange must be enabled): ${resolvedDatapoint}`,
        };
      }

      // Set value directly without any conversion - let ioBroker handle type validation
      this.log.info(
        `[DatapointController] Setting ${resolvedDatapoint} to ${value} (type: ${typeof value}) - Direct mode (ai-assistant style)`,
      );

      await this.adapter.setForeignStateAsync(resolvedDatapoint, {
        val: value,
        ack: false,
        from: `system.adapter.${this.adapter.namespace}`, // Mark as from our adapter
      });

      return {
        success: true,
        datapoint: resolvedDatapoint,
        value: value,
        message: `Successfully set ${resolvedDatapoint} to ${value}`,
      };
    } catch (error) {
      this.log.error(
        `[DatapointController] Error setting datapoint ${resolvedDatapoint}: ${error.message}`,
      );
      return {
        success: false,
        error: `Failed to set datapoint: ${error.message}`,
      };
    }
  }

  /**
   * Execute getState function
   *
   * @param {object} parameters - Function parameters
   * @returns {Promise<object>} Result of the operation
   */
  async executeGetState(parameters) {
    const { datapoint } = parameters;

    if (!datapoint) {
      throw new Error("Missing required parameter: datapoint");
    }

    // Resolve the datapoint ID (now async)
    const resolvedDatapoint = await this._resolveDatapointId(datapoint);
    if (!resolvedDatapoint) {
      this.log.warn(
        `[DatapointController] Could not resolve datapoint: "${datapoint}". Available: ${Array.from(this.allowedDatapoints).join(", ")}`,
      );
      throw new Error(`Datapoint not found: ${datapoint}`);
    }

    this.log.debug(
      `[DatapointController] Resolved "${datapoint}" -> "${resolvedDatapoint}"`,
    );

    try {
      const result = await this.getDatapointValue(resolvedDatapoint);

      if (result.success) {
        return {
          success: true,
          datapoint: resolvedDatapoint,
          originalInput: datapoint,
          value: result.value,
          timestamp: result.timestamp,
          message: `Current value of ${resolvedDatapoint} is ${result.value}`,
        };
      }
      throw new Error(result.error || "Failed to read datapoint");
    } catch (error) {
      this.log.error(
        `[DatapointController] Error reading ${resolvedDatapoint}: ${error.message}`,
      );
      throw new Error(`Failed to read ${resolvedDatapoint}: ${error.message}`);
    }
  }
}

module.exports = DatapointController;
